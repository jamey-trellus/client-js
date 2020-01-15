import {
    absolute,
    debug as _debug,
    getPath,
    setPath,
    jwtDecode,
    makeArray,
    request,
    byCode,
    byCodes,
    units,
    getPatientParam,
    fetchConformanceStatement
} from "./lib";

import str from "./strings";
import { SMART_KEY, patientCompartment, fhirVersions } from "./settings";
import HttpError from "./HttpError";
import BrowserAdapter from "./adapters/BrowserAdapter";
import { fhirclient } from "./types";

// $lab:coverage:off$
// @ts-ignore
const { Response } = typeof FHIRCLIENT_PURE !== "undefined" ? window : require("cross-fetch");
// $lab:coverage:on$

const debug = _debug.extend("client");

/**
 * Adds patient context to requestOptions object to be used with [[Client.request]]
 * @param requestOptions Can be a string URL (relative to the serviceUrl), or an
 * object which will be passed to fetch()
 * @param client Current FHIR client object containing patient context
 * @return requestOptions object contextualized to current patient
 */
async function contextualize(
    requestOptions: string | URL | fhirclient.RequestOptions,
    client: Client
): Promise<fhirclient.RequestOptions>
{
    const base = absolute("/", client.state.serverUrl);

    async function contextualURL(_url: URL) {
        const resourceType = _url.pathname.split("/").pop();

        if (!resourceType) {
            throw new Error(`Invalid url "${_url}"`);
        }

        if (patientCompartment.indexOf(resourceType) == -1) {
            throw new Error(`Cannot filter "${resourceType}" resources by patient`);
        }

        const conformance = await fetchConformanceStatement(client.state.serverUrl);
        const searchParam = getPatientParam(conformance, resourceType);
        _url.searchParams.set(searchParam, client.patient.id as string);
        return _url.href;
    }

    if (typeof requestOptions == "string" || requestOptions instanceof URL) {
        return { url: await contextualURL(new URL(requestOptions + "", base)) };
    }

    requestOptions.url = await contextualURL(new URL(requestOptions.url + "", base));
    return requestOptions;
}

/**
 * Gets single reference by id. Caches the result.
 * @param refId
 * @param cache A map to store the resolved refs
 * @param client The client instance
 * @param [signal] The `AbortSignal` if any
 * @returns The resolved reference
 * @private
 */
function getRef(
    refId: string,
    cache: fhirclient.JsonObject,
    client: Client,
    signal?: AbortSignal
): Promise<fhirclient.JsonObject> {
    const sub = cache[refId];
    if (!sub) {

        // Note that we set cache[refId] immediately! When the promise is
        // settled it will be updated. This is to avoid a ref being fetched
        // twice because some of these requests are executed in parallel.
        cache[refId] = client.request({
            url: refId,
            signal
        }).then(res => {
            cache[refId] = res;
            return res;
        }, (error: Error) => {
            delete cache[refId];
            throw error;
        });
        return cache[refId];
    }
    return sub;
}

/**
 * Resolves a reference in the given resource.
 * @param obj FHIR Resource
 */
function resolveRef(
    obj: fhirclient.FHIR.Resource,
    path: string,
    graph: boolean,
    cache: fhirclient.JsonObject,
    client: Client,
    signal?: AbortSignal
) {
    const node = getPath(obj, path);
    if (node) {
        const isArray = Array.isArray(node);
        return Promise.all(makeArray(node).map((item, i) => {
            const ref = item.reference;
            if (ref) {
                return getRef(ref, cache, client, signal).then(sub => {
                    if (graph) {
                        if (isArray) {
                            setPath(obj, `${path}.${i}`, sub);
                        } else {
                            setPath(obj, path, sub);
                        }
                    }
                }).catch((ex) => {
                    /* ignore missing references */
                    if (ex.status !== 404) {
                        throw ex;
                    }
                });
            }
        }));
    }
}

/**
 * Given a resource and a list of ref paths - resolves them all
 * @param obj FHIR Resource
 * @param fhirOptions The fhir options of the initiating request call
 * @param cache A map to store fetched refs
 * @param client The client instance
 * @private
 */
function resolveRefs(
    obj: fhirclient.FHIR.Resource,
    fhirOptions: fhirclient.FhirOptions,
    cache: fhirclient.JsonObject,
    client: Client,
    signal?: AbortSignal
) {

    // 1. Sanitize paths, remove any invalid ones
    let paths = makeArray(fhirOptions.resolveReferences)
        .filter(Boolean) // No false, 0, null, undefined or ""
        .map(path => String(path).trim())
        .filter(Boolean); // No space-only strings

    // 2. Remove duplicates
    paths = paths.filter((p, i) => {
        const index = paths.indexOf(p, i + 1);
        if (index > -1) {
            debug("Duplicated reference path \"%s\"", p);
            return false;
        }
        return true;
    });

    // 3. Early exit if no valid paths are found
    if (!paths.length) {
        return Promise.resolve();
    }

    // 4. Group the paths by depth so that child refs are looked up
    // after their parents!
    const groups: fhirclient.JsonObject = {};
    paths.forEach(path => {
        const len = path.split(".").length;
        if (!groups[len]) {
            groups[len] = [];
        }
        groups[len].push(path);
    });

    // 5. Execute groups sequentially! Paths within same group are
    // fetched in parallel!
    let task: Promise<any> = Promise.resolve();
    Object.keys(groups).sort().forEach(len => {
        const group = groups[len];
        task = task.then(() => Promise.all(group.map((path: string) => {
            return resolveRef(obj, path, !!fhirOptions.graph, cache, client, signal);
        })));
    });
    return task;
}

/**
 * This is a FHIR client that is returned to you from the `ready()` call of the
 * **SMART API**. You can also create it yourself if needed:
 *
 * ```js
 * // BROWSER
 * const client = FHIR.client("https://r4.smarthealthit.org");
 *
 * // SERVER
 * const client = smart(req, res).client("https://r4.smarthealthit.org");
 * ```
 */
export default class Client
{
    /**
     * The state of the client instance is an object with various properties.
     * It contains some details about how the client has been authorized and
     * determines the behavior of the client instance. This state is persisted
     * in `SessionStorage` in browsers or in request session on the servers.
     */
    readonly state: fhirclient.ClientState;

    /**
     * The adapter to use to connect to the current environment. Currently we have:
     * - BrowserAdapter - for browsers
     * - NodeAdapter - for Express or vanilla NodeJS servers
     * - HapiAdapter - for HAPI NodeJS servers
     */
    readonly environment: fhirclient.Adapter;

    /**
     * A SMART app is typically associated with a patient. This is a namespace
     * for the patient-related functionality of the client.
     */
    readonly patient: {

        /**
         * The ID of the current patient or `null` if there is no current patient
         */
        id: string | null

        /**
         * A method to fetch the current patient resource from the FHIR server.
         * If there is no patient context, it will reject with an error.
         * @param [requestOptions] Any options to pass to the `fetch` call.
         * @category Request
         */
        read: (requestOptions?: RequestInit) => Promise<fhirclient.FHIR.Patient>

        /**
         * This is similar to [[Client.request]] but it makes requests in the
         * context of the current patient. For example, instead of doing
         * ```js
         * client.request("Observation?patient=" + client.patient.id)
         * ```
         * you can do
         * ```js
         * client.patient.request("Observation")
         * ```
         * @category Request
         */
        request: (requestOptions: string|URL|fhirclient.RequestOptions, fhirOptions?: fhirclient.FhirOptions) => Promise<fhirclient.JsonObject>

        /**
         * This is the FhirJS Patient API. It will ONLY exist if the `Client`
         * instance is "connected" to FhirJS.
         */
        api?: fhirclient.JsonObject
    };

    /**
     * The client may be associated with a specific encounter, if the scopes
     * permit that and if the back-end server supports that. This is a namespace
     * for encounter-related functionality.
     */
    readonly encounter: {

        /**
         * The ID of the current encounter or `null` if there is no current
         * encounter
         */
        id: string | null

        /**
         * A method to fetch the current encounter resource from the FHIR server.
         * If there is no encounter context, it will reject with an error.
         * @param [requestOptions] Any options to pass to the `fetch` call.
         * @category Request
         */
        read: (requestOptions?: RequestInit) => Promise<fhirclient.FHIR.Encounter>
    };

    /**
     * The client may be associated with a specific user, if the scopes
     * permit that. This is a namespace for user-related functionality.
     */
    readonly user: {

        /**
         * The ID of the current user or `null` if there is no current user
         */
        id: string | null

        /**
         * A method to fetch the current user resource from the FHIR server.
         * If there is no user context, it will reject with an error.
         * @param [requestOptions] Any options to pass to the `fetch` call.
         * @category Request
         */
        read: (requestOptions?: RequestInit) => Promise<
            fhirclient.FHIR.Patient |
            fhirclient.FHIR.Practitioner |
            fhirclient.FHIR.RelatedPerson
        >

        /**
         * Returns the profile of the logged_in user (if any), or null if the
         * user is not available. This is a string having the shape
         * `{user type}/{user id}`. For example `Practitioner/abc` or
         * `Patient/xyz`.
         * @alias client.getFhirUser()
         */
        fhirUser: string | null

        /**
         * Returns the type of the logged-in user or null. The result can be
         * `Practitioner`, `Patient` or `RelatedPerson`.
         * @alias client.getUserType()
         */
        resourceType: string | null
    };

    /**
     * The [FhirJS](https://github.com/FHIR/fhir.js/blob/master/README.md) API.
     * **NOTE:** This will only be available if `fhir.js` is used. Otherwise it
     * will be `undefined`.
     */
    api: fhirclient.JsonObject | undefined;

    /**
     * Refers to the refresh task while it is being performed.
     * @see [[refresh]]
     */
    private _refreshTask: Promise<any> | null;

    /**
     * Validates the parameters, creates an instance and tries to connect it to
     * FhirJS, if one is available globally.
     */
    constructor(environment: fhirclient.Adapter, state: fhirclient.ClientState | string)
    {
        const _state = typeof state == "string" ? { serverUrl: state } : state;

        // Valid serverUrl is required!
        if (!_state.serverUrl || !_state.serverUrl.match(/https?:\/\/.+/)) {
            throw new Error("A \"serverUrl\" option is required and must begin with \"http(s)\"");
        }

        this.state = _state;
        this.environment = environment;
        this._refreshTask = null;

        const client = this;

        // patient api ---------------------------------------------------------
        this.patient = {
            get id() { return client.getPatientId(); },
            read: (requestOptions: RequestInit = {}) => {
                const id = this.patient.id;
                return id ?
                    this.request({ ...requestOptions, url: `Patient/${id}` }) :
                    Promise.reject(new Error("Patient is not available"));
            },
            request: (requestOptions, fhirOptions = {}) => {
                if (this.patient.id) {
                    return (async () => {
                        const options = await contextualize(requestOptions, this);
                        return this.request(options, fhirOptions);
                    })();
                } else {
                    return Promise.reject(new Error("Patient is not available"));
                }
            }
        };

        // encounter api -------------------------------------------------------
        this.encounter = {
            get id() { return client.getEncounterId(); },
            read: (requestOptions: RequestInit = {}) => {
                const id = this.encounter.id;
                return id ?
                    this.request({ ...requestOptions, url: `Encounter/${id}` }) :
                    Promise.reject(new Error("Encounter is not available"));
            }
        };

        // user api ------------------------------------------------------------
        this.user = {
            get fhirUser() { return client.getFhirUser(); },
            get id() { return client.getUserId(); },
            get resourceType() { return client.getUserType(); },
            read: (requestOptions: RequestInit = {}) => {
                const fhirUser = this.user.fhirUser;
                return fhirUser ?
                    this.request({ ...requestOptions, url: fhirUser }) :
                    Promise.reject(new Error("User is not available"));
            }
        };

        // fhir.js api (attached automatically in browser)
        // ---------------------------------------------------------------------
        this.connect((environment as BrowserAdapter).fhir);
    }

    /**
     * This method is used to make the "link" between the `fhirclient` and the
     * `fhir.js`, if one is available.
     * **Note:** This is called by the constructor. If fhir.js is available in
     * the global scope as `fhir`, it will automatically be linked to any [[Client]]
     * instance. You should only use this method to connect to `fhir.js` which
     * is not global.
     */
    connect(fhirJs?: (options: fhirclient.JsonObject) => fhirclient.JsonObject): Client
    {
        if (typeof fhirJs == "function") {
            const options: fhirclient.JsonObject = {
                baseUrl: this.state.serverUrl.replace(/\/$/, "")
            };

            const accessToken = getPath(this, "state.tokenResponse.access_token");
            if (accessToken) {
                options.auth = { token: accessToken };
            }
            else {
                const { username, password } = this.state;
                if (username && password) {
                    options.auth = {
                        user: username,
                        pass: password
                    };
                }
            }
            this.api = fhirJs(options);

            const patientId = getPath(this, "state.tokenResponse.patient");
            if (patientId) {
                this.patient.api = fhirJs({
                    ...options,
                    patient: patientId
                });
            }
        }
        return this;
    }

    /**
     * Returns the ID of the selected patient or null. You should have requested
     * "launch/patient" scope. Otherwise this will return null.
     */
    getPatientId(): string | null
    {
        const tokenResponse = this.state.tokenResponse;
        if (tokenResponse) {
            // We have been authorized against this server but we don't know
            // the patient. This should be a scope issue.
            if (!tokenResponse.patient) {
                if (!(this.state.scope || "").match(/\blaunch(\/patient)?\b/)) {
                    debug(str.noScopeForId, "patient", "patient");
                }
                else {
                    // The server should have returned the patient!
                    debug("The ID of the selected patient is not available. Please check if your server supports that.");
                }
                return null;
            }
            return tokenResponse.patient;
        }

        if (this.state.authorizeUri) {
            debug(str.noIfNoAuth, "the ID of the selected patient");
        }
        else {
            debug(str.noFreeContext, "selected patient");
        }
        return null;
    }

    /**
     * Returns the ID of the selected encounter or null. You should have
     * requested "launch/encounter" scope. Otherwise this will return null.
     * Note that not all servers support the "launch/encounter" scope so this
     * will be null if they don't.
     */
    getEncounterId(): string | null
    {
        const tokenResponse = this.state.tokenResponse;
        if (tokenResponse) {
            // We have been authorized against this server but we don't know
            // the encounter. This should be a scope issue.
            if (!tokenResponse.encounter) {
                if (!(this.state.scope || "").match(/\blaunch(\/encounter)?\b/)) {
                    debug(str.noScopeForId, "encounter", "encounter");
                }
                else {
                    // The server should have returned the encounter!
                    debug("The ID of the selected encounter is not available. Please check if your server supports that, and that the selected patient has any recorded encounters.");
                }
                return null;
            }
            return tokenResponse.encounter;
        }

        if (this.state.authorizeUri) {
            debug(str.noIfNoAuth, "the ID of the selected encounter");
        }
        else {
            debug(str.noFreeContext, "selected encounter");
        }
        return null;
    }

    /**
     * Returns the (decoded) id_token if any. You need to request "openid" and
     * "profile" scopes if you need to receive an id_token (if you need to know
     * who the logged-in user is).
     */
    getIdToken(): fhirclient.IDToken | null
    {
        const tokenResponse = this.state.tokenResponse;
        if (tokenResponse) {
            const idToken = tokenResponse.id_token;
            const scope = this.state.scope || "";

            // We have been authorized against this server but we don't have
            // the id_token. This should be a scope issue.
            if (!idToken) {
                const hasOpenid   = scope.match(/\bopenid\b/);
                const hasProfile  = scope.match(/\bprofile\b/);
                const hasFhirUser = scope.match(/\bfhirUser\b/);
                if (!hasOpenid || !(hasFhirUser || hasProfile)) {
                    debug(
                        "You are trying to get the id_token but you are not " +
                        "using the right scopes. Please add 'openid' and " +
                        "'fhirUser' or 'profile' to the scopes you are " +
                        "requesting."
                    );
                }
                else {
                    // The server should have returned the id_token!
                    debug("The id_token is not available. Please check if your server supports that.");
                }
                return null;
            }
            return jwtDecode(idToken, this.environment);
        }
        if (this.state.authorizeUri) {
            debug(str.noIfNoAuth, "the id_token");
        }
        else {
            debug(str.noFreeContext, "id_token");
        }
        return null;
    }

    /**
     * Returns the profile of the logged_in user (if any). This is a string
     * having the following shape `"{user type}/{user id}"`. For example:
     * `"Practitioner/abc"` or `"Patient/xyz"`.
     */
    getFhirUser(): string | null
    {
        const idToken = this.getIdToken();
        if (idToken) {
            return idToken.profile;
        }
        return null;
    }

    /**
     * Returns the user ID or null.
     */
    getUserId(): string | null
    {
        const profile = this.getFhirUser();
        if (profile) {
            return profile.split("/")[1];
        }
        return null;
    }

    /**
     * Returns the type of the logged-in user or null. The result can be
     * "Practitioner", "Patient" or "RelatedPerson".
     */
    getUserType(): string | null
    {
        const profile = this.getFhirUser();
        if (profile) {
            return profile.split("/")[0];
        }
        return null;
    }

    /**
     * Builds and returns the value of the `Authorization` header that can be
     * sent to the FHIR server
     */
    getAuthorizationHeader(): string | null
    {
        const accessToken = getPath(this, "state.tokenResponse.access_token");
        if (accessToken) {
            return "Bearer " + accessToken;
        }
        const { username, password } = this.state;
        if (username && password) {
            return "Basic " + this.environment.btoa(username + ":" + password);
        }
        return null;
    }

    /**
     * Used internally to clear the state of the instance and the state in the
     * associated storage.
     */
    private async _clearState() {
        const storage = this.environment.getStorage();
        const key = await storage.get(SMART_KEY);
        if (key) {
            await storage.unset(key);
        }
        await storage.unset(SMART_KEY);
        this.state.tokenResponse = {};
    }

    /**
     * Creates a new resource in a server-assigned location
     * @see http://hl7.org/fhir/http.html#create
     * @param resource A FHIR resource to be created
     * @param [requestOptions] Any options to be passed to the fetch call.
     * Note that `method`, `body` and `headers["Content-Type"]` will be ignored
     * but other headers can be added.
     * @category Request
     */
    create(resource: fhirclient.FHIR.Resource, requestOptions: RequestInit = {}): Promise<fhirclient.FHIR.Resource>
    {
        return this.request<fhirclient.FHIR.Resource>({
            ...requestOptions,
            url: `${resource.resourceType}`,
            method: "POST",
            body: JSON.stringify(resource),
            headers: {
                ...requestOptions.headers || {},
                // TODO: Do we need to alternate with "application/json+fhir"?
                "Content-Type": "application/fhir+json"
            }
        });
    }

    /**
     * Creates a new current version for an existing resource or creates an
     * initial version if no resource already exists for the given id.
     * @see http://hl7.org/fhir/http.html#update
     * @param resource A FHIR resource to be updated
     * @param requestOptions Any options to be passed to the fetch call.
     * Note that `method`, `body` and `headers["Content-Type"]` will be ignored
     * but other headers can be added.
     * @category Request
     */
    update(resource: fhirclient.FHIR.Resource, requestOptions: RequestInit = {}): Promise<fhirclient.FHIR.Resource>
    {
        return this.request<fhirclient.FHIR.Resource>({
            ...requestOptions,
            url: `${resource.resourceType}/${resource.id}`,
            method: "PUT",
            body: JSON.stringify(resource),
            headers: {
                ...requestOptions.headers || {},
                // TODO: Do we need to alternate with "application/json+fhir"?
                "Content-Type": "application/fhir+json"
            }
        });
    }

    /**
     * Removes an existing resource.
     * @see http://hl7.org/fhir/http.html#delete
     * @param url Relative URI of the FHIR resource to be deleted
     * (format: `resourceType/id`)
     * @param requestOptions Any options (except `method` which will be fixed
     * to `DELETE`) to be passed to the fetch call.
     * @category Request
     */
    delete(url: string, requestOptions: RequestInit = {}): Promise<fhirclient.FHIR.Resource>
    {
        return this.request<fhirclient.FHIR.Resource>({
            ...requestOptions,
            url,
            method: "DELETE"
        });
    }

    /**
     * @param requestOptions Can be a string URL (relative to the serviceUrl),
     * or an object which will be passed to fetch()
     * @param fhirOptions Additional options to control the behavior
     * @param _resolvedRefs DO NOT USE! Used internally.
     * @category Request
     */
    async request<T = any>(
        requestOptions: string|URL|fhirclient.RequestOptions,
        fhirOptions: fhirclient.FhirOptions = {},
        _resolvedRefs: fhirclient.JsonObject = {}
    ): Promise<T>
    {
        const debugRequest = _debug.extend("client:request");
        if (!requestOptions) {
            throw new Error("request requires an url or request options as argument");
        }

        // url -----------------------------------------------------------------
        let url: string;
        if (typeof requestOptions == "string" || requestOptions instanceof URL) {
            url = String(requestOptions);
            requestOptions = {} as fhirclient.RequestOptions;
        }
        else {
            url = String(requestOptions.url);
        }

        url = absolute(url, this.state.serverUrl);

        // authentication ------------------------------------------------------
        const authHeader = this.getAuthorizationHeader();
        if (authHeader) {
            requestOptions.headers = {
                ...requestOptions.headers,
                Authorization: authHeader
            };
        }

        const options = {
            graph: fhirOptions.graph !== false,
            flat : !!fhirOptions.flat,
            pageLimit: fhirOptions.pageLimit ?? 1,
            resolveReferences: (fhirOptions.resolveReferences || []) as string[],
            useRefreshToken: fhirOptions.useRefreshToken !== false,
            onPage: typeof fhirOptions.onPage == "function" ?
                fhirOptions.onPage as (
                    data: fhirclient.JsonObject | fhirclient.JsonObject[],
                    references?: fhirclient.JsonObject | undefined) => any :
                undefined
        };

        debugRequest(
            "%s, options: %O, fhirOptions: %O",
            url,
            requestOptions,
            options
        );

        const signal = (requestOptions as RequestInit).signal || undefined;


        return request(url, requestOptions)

            // Automatic re-auth via refresh token -----------------------------
            .catch((error: HttpError) => {
                debugRequest("%o", error);
                if (error.status == 401 && options.useRefreshToken) {
                    const hasRefreshToken = getPath(this, "state.tokenResponse.refresh_token");
                    if (hasRefreshToken) {
                        return this.refresh({ signal }).then(() => this.request(
                            { ...(requestOptions as fhirclient.RequestOptions), url },
                            options,
                            _resolvedRefs
                        ));
                    }
                }
                throw error;
            })

            // Handle 401 ------------------------------------------------------
            .catch(async (error: HttpError) => {
                if (error.status == 401) {

                    // !accessToken -> not authorized -> No session. Need to launch.
                    if (!getPath(this, "state.tokenResponse.access_token")) {
                        throw new Error("This app cannot be accessed directly. Please launch it as SMART app!");
                    }

                    // auto-refresh not enabled and Session expired.
                    // Need to re-launch. Clear state to start over!
                    if (!options.useRefreshToken) {
                        debugRequest("Your session has expired and the useRefreshToken option is set to false. Please re-launch the app.");
                        await this._clearState();
                        throw new Error(str.expired);
                    }

                    // otherwise -> auto-refresh failed. Session expired.
                    // Need to re-launch. Clear state to start over!
                    debugRequest("Auto-refresh failed! Please re-launch the app.");
                    await this._clearState();
                    throw new Error(str.expired);
                }
                throw error;
            })

            // Handle 403 ------------------------------------------------------
            .catch((error: HttpError) => {
                if (error.status == 403) {
                    debugRequest("Permission denied! Please make sure that you have requested the proper scopes.");
                }
                throw error;
            })

            .then(data => {

                // Handle raw responses (anything other than json) -------------
                if (!data)
                    return data;
                if (typeof data == "string")
                    return data;
                if (data instanceof Response)
                    return data;

                // Resolve References ------------------------------------------
                return (async (_data) => {

                    if (_data.resourceType == "Bundle") {
                        await Promise.all((_data.entry as fhirclient.FHIR.BundleEntry[] || []).map(item => resolveRefs(
                            item.resource,
                            options,
                            _resolvedRefs,
                            this,
                            signal
                        )));
                    }
                    else {
                        await resolveRefs(
                            _data,
                            options,
                            _resolvedRefs,
                            this,
                            signal
                        );
                    }

                    return _data;
                })(data)

                    // Pagination ----------------------------------------------
                    .then(async _data => {
                        if (_data && _data.resourceType == "Bundle") {
                            const links = (_data.link || []) as fhirclient.FHIR.BundleLink[];

                            if (options.flat) {
                                _data = (_data.entry || []).map(
                                    (entry: fhirclient.FHIR.BundleEntry) => entry.resource
                                );
                            }

                            if (options.onPage) {
                                await options.onPage(_data, { ..._resolvedRefs });
                            }

                            if (--options.pageLimit) {
                                const next = links.find(l => l.relation == "next");
                                _data = makeArray(_data);
                                if (next && next.url) {
                                    const nextPage = await this.request(
                                        {
                                            url: next.url,

                                            // Aborting the main request (even after it is complete)
                                            // must propagate to any child requests and abort them!
                                            // To do so, just pass the same AbortSignal if one is
                                            // provided.
                                            signal
                                        },
                                        options,
                                        _resolvedRefs
                                    );

                                    if (options.onPage) {
                                        return null;
                                    }

                                    if (options.resolveReferences.length) {
                                        Object.assign(_resolvedRefs, nextPage.references);
                                        return _data.concat(makeArray(nextPage.data || nextPage));
                                    }
                                    return _data.concat(makeArray(nextPage));
                                }
                            }
                        }
                        return _data;
                    })

                    // Finalize ------------------------------------------------
                    .then(_data => {
                        if (options.graph) {
                            _resolvedRefs = {};
                        }
                        else if (!options.onPage && options.resolveReferences.length) {
                            return {
                                data: _data,
                                references: _resolvedRefs
                            };
                        }
                        return _data;
                    });
            });
    }

    /**
     * Use the refresh token to obtain new access token. If the refresh token is
     * expired (or this fails for any other reason) it will be deleted from the
     * state, so that we don't enter into loops trying to re-authorize.
     *
     * This method is typically called internally from [[Client.request]] if
     * certain request fails with 401.
     *
     * @param requestOptions Any options to pass to the fetch call. Most of them
     * will be overridden, bit it might still be useful for passing additional
     * request calls or an abort signal.
     * @category Request
     */
    refresh(requestOptions: RequestInit = {}): Promise<fhirclient.ClientState>
    {
        const debugRefresh = _debug.extend("client:refresh");
        debugRefresh("Attempting to refresh with refresh_token...");

        const refreshToken = this.state?.tokenResponse?.refresh_token;
        if (!refreshToken) {
            throw new Error("Unable to refresh. No refresh_token found.");
        }

        const tokenUri = this.state.tokenUri;
        if (!tokenUri) {
            throw new Error("Unable to refresh. No tokenUri found.");
        }

        const scopes = getPath(this, "state.tokenResponse.scope") || "";
        if (scopes.indexOf("offline_access") == -1 && scopes.indexOf("online_access") == -1) {
            throw new Error("Unable to refresh. No offline_access or online_access scope found.");
        }

        // This method is typically called internally from `request` if certain
        // request fails with 401. However, clients will often run multiple
        // requests in parallel which may result in multiple refresh calls.
        // To avoid that, we keep a to the current refresh task (if any).
        if (!this._refreshTask) {
            this._refreshTask = request<fhirclient.TokenResponse>(tokenUri, {
                ...requestOptions,
                mode   : "cors",
                method : "POST",
                headers: {
                    ...(requestOptions.headers || {}),
                    "content-type": "application/x-www-form-urlencoded"
                },
                body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
                credentials: "include"
            }).then(data => {
                if (!data.access_token) {
                    throw new Error("No access token received");
                }
                return data;
            }).then(data => {
                debugRefresh("Received new access token %O", data);
                Object.assign(this.state.tokenResponse, data);
                return this.state;
            }).catch((error: Error) => {
                if (this.state?.tokenResponse?.refresh_token) {
                    debugRefresh("Deleting the expired or invalid refresh token.");
                    delete this.state.tokenResponse.refresh_token;
                }
                throw error;
            }).finally(() => {
                this._refreshTask = null;
                const key = this.state.key;
                if (key) {
                    this.environment.getStorage().set(key, this.state);
                } else {
                    debugRefresh("No 'key' found in Clint.state. Cannot persist the instance.");
                }
            });
        }

        return this._refreshTask;
    }

    // utils -------------------------------------------------------------------

    /**
     * Groups the observations by code. Returns a map that will look like:
     * ```js
     * const map = client.byCodes(observations, "code");
     * // map = {
     * //     "55284-4": [ observation1, observation2 ],
     * //     "6082-2": [ observation3 ]
     * // }
     * ```
     * @param observations Array of observations
     * @param property The name of a CodeableConcept property to group by
     * @todo This should be deprecated and moved elsewhere. One should not have
     * to obtain an instance of [[Client]] just to use utility functions like this.
     * @deprecated
     * @category Utility
     */
    byCode(
        observations: fhirclient.FHIR.Observation | fhirclient.FHIR.Observation[],
        property: string
    ): fhirclient.ObservationMap
    {
        return byCode(observations, property);
    }

    /**
     * First groups the observations by code using `byCode`. Then returns a function
     * that accepts codes as arguments and will return a flat array of observations
     * having that codes. Example:
     * ```js
     * const filter = client.byCodes(observations, "category");
     * filter("laboratory") // => [ observation1, observation2 ]
     * filter("vital-signs") // => [ observation3 ]
     * filter("laboratory", "vital-signs") // => [ observation1, observation2, observation3 ]
     * ```
     * @param observations Array of observations
     * @param property The name of a CodeableConcept property to group by
     * @todo This should be deprecated and moved elsewhere. One should not have
     * to obtain an instance of [[Client]] just to use utility functions like this.
     * @deprecated
     * @category Utility
     */
    byCodes(
        observations: fhirclient.FHIR.Observation | fhirclient.FHIR.Observation[],
        property: string
    ): (...codes: string[]) => any[]
    {
        return byCodes(observations, property);
    }

    /**
     * @category Utility
     */
    units = units;

    /**
     * Walks through an object (or array) and returns the value found at the
     * provided path. This function is very simple so it intentionally does not
     * support any argument polymorphism, meaning that the path can only be a
     * dot-separated string. If the path is invalid returns undefined.
     * @param obj The object (or Array) to walk through
     * @param path The path (eg. "a.b.4.c")
     * @returns {*} Whatever is found in the path or undefined
     * @todo This should be deprecated and moved elsewhere. One should not have
     * to obtain an instance of [[Client]] just to use utility functions like this.
     * @deprecated
     * @category Utility
     */
    getPath(obj: fhirclient.JsonObject, path = ""): any {
        return getPath(obj, path);
    }

    /**
     * Returns a promise that will be resolved with the fhir version as defined
     * in the CapabilityStatement.
     */
    getFhirVersion(): Promise<string> {
        return fetchConformanceStatement(this.state.serverUrl)
            .then((metadata) => metadata.fhirVersion);
    }

    /**
     * Returns a promise that will be resolved with the numeric fhir version
     * - 2 for DSTU2
     * - 3 for STU3
     * - 4 for R4
     * - 0 if the version is not known
     */
    getFhirRelease(): Promise<number> {
        return this.getFhirVersion().then(v => (fhirVersions as fhirclient.JsonObject)[v] ?? 0);
    }
}