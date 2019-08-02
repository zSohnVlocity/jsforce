/*global Buffer */
/**
 * @file Connection class to keep the API session information and manage requests
 * @author Shinichi Tomita <shinichi.tomita@gmail.com>
 */

'use strict';

var events = require('events'),
  inherits = require('inherits'),
  _ = require('lodash/core'),
  Promise = require('./promise'),
  Logger = require('./logger'),
  OAuth2 = require('./oauth2'),
  Query = require('./query'),
  SObject = require('./sobject'),
  HttpApi = require('./http-api'),
  Transport = require('./transport'),
  Process = require('./process'),
  Cache = require('./cache');

var defaults = {
  loginUrl: "https://login.salesforce.com",
  instanceUrl: "",
  version: "42.0"
};

/*
 * Constant of maximum records num in DML operation (update/delete)
 */
var MAX_DML_COUNT = 200;


/**
 * Connection class to keep the API session information and manage requests
 *
 * @constructor
 * @extends events.EventEmitter
 * @param {Object} [options] - Connection options
 * @param {OAuth2|Object} [options.oauth2] - OAuth2 instance or options to be passed to OAuth2 constructor
 * @param {String} [options.logLevel] - Output logging level (DEBUG|INFO|WARN|ERROR|FATAL)
 * @param {String} [options.version] - Salesforce API Version (without "v" prefix)
 * @param {Number} [options.maxRequest] - Max number of requests allowed in parallel call
 * @param {String} [options.loginUrl] - Salesforce Login Server URL (e.g. https://login.salesforce.com/)
 * @param {String} [options.instanceUrl] - Salesforce Instance URL (e.g. https://na1.salesforce.com/)
 * @param {String} [options.serverUrl] - Salesforce SOAP service endpoint URL (e.g. https://na1.salesforce.com/services/Soap/u/28.0)
 * @param {String} [options.accessToken] - Salesforce OAuth2 access token
 * @param {String} [options.sessionId] - Salesforce session ID
 * @param {String} [options.refreshToken] - Salesforce OAuth2 refresh token
 * @param {String|Object} [options.signedRequest] - Salesforce Canvas signed request (Raw Base64 string, JSON string, or deserialized JSON)
 * @param {String} [options.proxyUrl] - Cross-domain proxy server URL, used in browser client, non Visualforce app.
 * @param {String} [options.httpProxy] - URL of HTTP proxy server, used in server client.
 * @param {Object} [options.callOptions] - Call options used in each SOAP/REST API request. See manual.
 */
var Connection = module.exports = function (options) {
  options = options || {};

  this._logger = new Logger(options.logLevel);

  var oauth2 = options.oauth2 || {
    loginUrl: options.loginUrl,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    redirectUri: options.redirectUri,
    proxyUrl: options.proxyUrl,
    httpProxy: options.httpProxy
  };

  /**
   * OAuth2 object
   * @member {OAuth2} Connection#oauth2
   */
  this.oauth2 = oauth2 = oauth2 instanceof OAuth2 ? oauth2 : new OAuth2(oauth2);

  this.loginUrl = options.loginUrl || oauth2.loginUrl || defaults.loginUrl;
  this.version = options.version || defaults.version;
  this.maxRequest = options.maxRequest || this.maxRequest || 10;

  /** @private */
  if (options.proxyUrl) {
    this._transport = new Transport.ProxyTransport(options.proxyUrl);
  } else if (options.httpProxy) {
    this._transport = new Transport.HttpProxyTransport(options.httpProxy);
  } else {
    this._transport = new Transport();
  }

  this.callOptions = options.callOptions;

  /*
   * Fire connection:new event to notify jsforce plugin modules
   */
  var jsforce = require('./core');
  jsforce.emit('connection:new', this);

  /**
   * Apex REST API object
   * @member {Apex} Connection#apex
   */
  // this.apex = new Apex(this);

  /**
   * @member {Process} Connection#process
   */
  this.process = new Process(this);

  /**
   * Cache object for result
   * @member {Cache} Connection#cache
   */
  this.cache = new Cache();

  // Allow to delegate connection refresh to outer function
  var self = this;
  var refreshFn = options.refreshFn;
  if (!refreshFn && this.oauth2.clientId) {
    refreshFn = oauthRefreshFn;
  }
  if (refreshFn) {
    this._refreshDelegate = new HttpApi.SessionRefreshDelegate(this, refreshFn);
  }

  var cacheOptions = {
    key: function (type) { return type ? "describe." + type : "describe"; }
  };
  this.describe$ = this.cache.makeCacheable(this.describe, this, cacheOptions);
  this.describe = this.cache.makeResponseCacheable(this.describe, this, cacheOptions);
  this.describeSObject$ = this.describe$;
  this.describeSObject = this.describe;

  cacheOptions = { key: 'describeGlobal' };
  this.describeGlobal$ = this.cache.makeCacheable(this.describeGlobal, this, cacheOptions);
  this.describeGlobal = this.cache.makeResponseCacheable(this.describeGlobal, this, cacheOptions);

  this.initialize(options);
};

inherits(Connection, events.EventEmitter);

/**
 * Initialize connection.
 *
 * @protected
 * @param {Object} options - Initialization options
 * @param {String} [options.instanceUrl] - Salesforce Instance URL (e.g. https://na1.salesforce.com/)
 * @param {String} [options.serverUrl] - Salesforce SOAP service endpoint URL (e.g. https://na1.salesforce.com/services/Soap/u/28.0)
 * @param {String} [options.accessToken] - Salesforce OAuth2 access token
 * @param {String} [options.sessionId] - Salesforce session ID
 * @param {String} [options.refreshToken] - Salesforce OAuth2 refresh token
 * @param {String|Object} [options.signedRequest] - Salesforce Canvas signed request (Raw Base64 string, JSON string, or deserialized JSON)
 * @param {UserInfo} [options.userInfo] - Logged in user information
 */
Connection.prototype.initialize = function (options) {
  if (!options.instanceUrl && options.serverUrl) {
    options.instanceUrl = options.serverUrl.split('/').slice(0, 3).join('/');
  }
  this.instanceUrl = options.instanceUrl || options.serverUrl || this.instanceUrl || defaults.instanceUrl;

  this.accessToken = options.sessionId || options.accessToken || this.accessToken;
  this.refreshToken = options.refreshToken || this.refreshToken;
  if (this.refreshToken && !this._refreshDelegate) {
    throw new Error("Refresh token is specified without oauth2 client information or refresh function");
  }

  this.signedRequest = options.signedRequest && parseSignedRequest(options.signedRequest);
  if (this.signedRequest) {
    this.accessToken = this.signedRequest.client.oauthToken;
    if (Transport.CanvasTransport.supported) {
      this._transport = new Transport.CanvasTransport(this.signedRequest);
    }
  }

  if (options.userInfo) {
    this.userInfo = options.userInfo;
  }

  this.limitInfo = {};

  this.sobjects = {};
  this.cache.clear();
  this.cache.get('describeGlobal').removeAllListeners('value');
  this.cache.get('describeGlobal').on('value', _.bind(function (res) {
    if (res.result) {
      var types = _.map(res.result.sobjects, function (so) { return so.name; });
      types.forEach(this.sobject, this);
    }
  }, this));

  if (this.tooling) {
    this.tooling.initialize();
  }

  this._sessionType = options.sessionId ? "soap" : "oauth2";

};


/** @private **/
function oauthRefreshFn(conn, callback) {
  conn.oauth2.refreshToken(conn.refreshToken, function (err, res) {
    if (err) { return callback(err); }
    var userInfo = parseIdUrl(res.id);
    conn.initialize({
      instanceUrl: res.instance_url,
      accessToken: res.access_token,
      userInfo: userInfo
    });
    callback(null, res.access_token, res);
  });
}

/** @private **/
function parseSignedRequest(sr) {
  if (_.isString(sr)) {
    if (sr[0] === '{') { // might be JSON
      return JSON.parse(sr);
    } else { // might be original base64-encoded signed request
      var msg = sr.split('.').pop(); // retrieve latter part
      var json = Buffer.from(msg, 'base64').toString('utf-8');
      return JSON.parse(json);
    }
    return null;
  }
  return sr;
}


/** @private **/
Connection.prototype._baseUrl = function () {
  return [this.instanceUrl, "services/data", "v" + this.version].join('/');
};

/**
 * Convert path to absolute url
 * @private
 */
Connection.prototype._normalizeUrl = function (url) {
  if (url[0] === '/') {
    if (url.indexOf('/services/') === 0) {
      return this.instanceUrl + url;
    } else {
      return this._baseUrl() + url;
    }
  } else {
    return url;
  }
};

/**
 * Send REST API request with given HTTP request info, with connected session information.
 *
 * Endpoint URL can be absolute URL ('https://na1.salesforce.com/services/data/v32.0/sobjects/Account/describe')
 * , relative path from root ('/services/data/v32.0/sobjects/Account/describe')
 * , or relative path from version root ('/sobjects/Account/describe').
 *
 * @param {String|Object} request - HTTP request object or URL to GET request
 * @param {String} request.method - HTTP method URL to send HTTP request
 * @param {String} request.url - URL to send HTTP request
 * @param {Object} [request.headers] - HTTP request headers in hash object (key-value)
 * @param {Object} [options] - HTTP API request options
 * @param {Callback.<Object>} [callback] - Callback function
 * @returns {Promise.<Object>}
 */
Connection.prototype.request = function (request, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = null;
  }
  options = options || {};
  var self = this;

  // if request is simple string, regard it as url in GET method
  if (_.isString(request)) {
    request = { method: 'GET', url: request };
  }
  // if url is given in relative path, prepend base url or instance url before.
  request.url = this._normalizeUrl(request.url);

  var httpApi = new HttpApi(this, options);

  // log api usage and its quota
  httpApi.on('response', function (response) {
    if (response.headers && response.headers["sforce-limit-info"]) {
      var apiUsage = response.headers["sforce-limit-info"].match(/api\-usage=(\d+)\/(\d+)/);
      if (apiUsage) {
        self.limitInfo = {
          apiUsage: {
            used: parseInt(apiUsage[1], 10),
            limit: parseInt(apiUsage[2], 10)
          }
        };
      }
    }
  });
  return httpApi.request(request).thenCall(callback);
};


/** @private **/
function parseIdUrl(idUrl) {
  var idUrls = idUrl.split("/");
  var userId = idUrls.pop(), orgId = idUrls.pop();
  return {
    id: userId,
    organizationId: orgId,
    url: idUrl
  };
}


/**
 * Execute query by using SOQL
 *
 * @param {String} soql - SOQL string
 * @param {Object} [options] - Query options
 * @param {Object} [options.headers] - Additional HTTP request headers sent in query request
 * @param {Callback.<QueryResult>} [callback] - Callback function
 * @returns {Query.<QueryResult>}
 */
Connection.prototype.query = function (soql, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = undefined;
  }
  var query = new Query(this, soql, options);
  if (callback) {
    query.run(callback);
  }
  return query;
};


/**
 * Execute search by SOSL
 *
 * @param {String} sosl - SOSL string
 * @param {Callback.<Array.<RecordResult>>} [callback] - Callback function
 * @returns {Promise.<Array.<RecordResult>>}
 */
Connection.prototype.search = function (sosl, callback) {
  var url = this._baseUrl() + "/search?q=" + encodeURIComponent(sosl);
  return this.request(url).thenCall(callback);
};

/**
 * @typedef UserInfo
 * @prop {String} id - User ID
 * @prop {String} organizationId - Organization ID
 * @prop {String} url - Identity URL of the user
 */




/**
 * Login to Salesforce
 *
 * @param {String} username - Salesforce username
 * @param {String} password - Salesforce password (and security token, if required)
 * @param {Callback.<UserInfo>} [callback] - Callback function
 * @returns {Promise.<UserInfo>}
 */
Connection.prototype.login = function (username, password, callback) {
  // register refreshDelegate for session expiration
  this._refreshDelegate = new HttpApi.SessionRefreshDelegate(this, createUsernamePasswordRefreshFn(username, password));
  if (this.oauth2 && this.oauth2.clientId && this.oauth2.clientSecret) {
    return this.loginByOAuth2(username, password, callback);
  } else {
    return this.loginBySoap(username, password, callback);
  }
};

/** @private **/
function createUsernamePasswordRefreshFn(username, password) {
  return function (conn, callback) {
    conn.login(username, password, function (err) {
      if (err) { return callback(err); }
      callback(null, conn.accessToken);
    });
  };
}

/**
 * Login by OAuth2 username & password flow
 *
 * @param {String} username - Salesforce username
 * @param {String} password - Salesforce password (and security token, if required)
 * @param {Callback.<UserInfo>} [callback] - Callback function
 * @returns {Promise.<UserInfo>}
 */
Connection.prototype.loginByOAuth2 = function (username, password, callback) {
  var self = this;
  var logger = this._logger;
  return this.oauth2.authenticate(username, password).then(function (res) {
    var userInfo = parseIdUrl(res.id);
    self.initialize({
      instanceUrl: res.instance_url,
      accessToken: res.access_token,
      userInfo: userInfo
    });
    logger.debug("<login> completed. user id = " + userInfo.id + ", org id = " + userInfo.organizationId);
    return userInfo;

  }).thenCall(callback);

};

/**
 * @private
 */
function esc(str) {
  return str && String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Login by SOAP web service API
 *
 * @param {String} username - Salesforce username
 * @param {String} password - Salesforce password (and security token, if required)
 * @param {Callback.<UserInfo>} [callback] - Callback function
 * @returns {Promise.<UserInfo>}
 */
Connection.prototype.loginBySoap = function (username, password, callback) {
  var self = this;
  var logger = this._logger;
  var body = [
    '<se:Envelope xmlns:se="http://schemas.xmlsoap.org/soap/envelope/">',
    '<se:Header/>',
    '<se:Body>',
    '<login xmlns="urn:partner.soap.sforce.com">',
    '<username>' + esc(username) + '</username>',
    '<password>' + esc(password) + '</password>',
    '</login>',
    '</se:Body>',
    '</se:Envelope>'
  ].join('');

  var soapLoginEndpoint = [this.loginUrl, "services/Soap/u", this.version].join('/');

  return this._transport.httpRequest({
    method: 'POST',
    url: soapLoginEndpoint,
    body: body,
    headers: {
      "Content-Type": "text/xml",
      "SOAPAction": '""'
    }
  }).then(function (response) {
    var m;
    if (response.statusCode >= 400) {
      m = response.body.match(/<faultstring>([^<]+)<\/faultstring>/);
      var faultstring = m && m[1];
      throw new Error(faultstring || response.body);
    }
    logger.debug("SOAP response = " + response.body);
    m = response.body.match(/<serverUrl>([^<]+)<\/serverUrl>/);
    var serverUrl = m && m[1];
    m = response.body.match(/<sessionId>([^<]+)<\/sessionId>/);
    var sessionId = m && m[1];
    m = response.body.match(/<userId>([^<]+)<\/userId>/);
    var userId = m && m[1];
    m = response.body.match(/<organizationId>([^<]+)<\/organizationId>/);
    var orgId = m && m[1];
    var idUrl = soapLoginEndpoint.split('/').slice(0, 3).join('/');
    idUrl += "/id/" + orgId + "/" + userId;
    var userInfo = {
      id: userId,
      organizationId: orgId,
      url: idUrl
    };
    self.initialize({
      serverUrl: serverUrl.split('/').slice(0, 3).join('/'),
      sessionId: sessionId,
      userInfo: userInfo
    });
    logger.debug("<login> completed. user id = " + userId + ", org id = " + orgId);
    return userInfo;

  }).thenCall(callback);

};

/**
 * Logout the current session 
 *
 * @param {Boolean} [revoke] - Revokes API Access if set to true
 * @param {Callback.<undefined>} [callback] - Callback function
 * @returns {Promise.<undefined>}
 */
Connection.prototype.logout = function (revoke, callback) {
  if (typeof revoke === 'function') {
    callback = revoke;
    revoke = false;
  }

  if (this._sessionType === "oauth2") {
    return this.logoutByOAuth2(revoke, callback);
  } else {
    return this.logoutBySoap(revoke, callback);
  }
};

/**
 * Logout the current session by revoking access token via OAuth2 session revoke
 *
 * @param {Boolean} [revoke] - Revokes API Access if set to true
 * @param {Callback.<undefined>} [callback] - Callback function
 * @returns {Promise.<undefined>}
 */
Connection.prototype.logoutByOAuth2 = function (revoke, callback) {
  if (typeof revoke === 'function') {
    callback = revoke;
    revoke = false;
  }
  var self = this;
  var logger = this._logger;

  return this.oauth2.revokeToken(revoke ? this.refreshToken : this.accessToken).then(function () {
    // Destroy the session bound to this connection
    self.accessToken = null;
    self.userInfo = null;
    self.refreshToken = null;
    self.instanceUrl = null;
    self.cache.clear();

    // nothing useful returned by logout API, just return
    return undefined;
  }).thenCall(callback);
};


/**
 * Logout the session by using SOAP web service API
 *
 * @param {Boolean} [revoke] - Revokes API Access if set to true
 * @param {Callback.<undefined>} [callback] - Callback function
 * @returns {Promise.<undefined>}
 */
Connection.prototype.logoutBySoap = function (revoke, callback) {
  if (typeof revoke === 'function') {
    callback = revoke;
    revoke = false;
  }
  var self = this;
  var logger = this._logger;

  var body = [
    '<se:Envelope xmlns:se="http://schemas.xmlsoap.org/soap/envelope/">',
    '<se:Header>',
    '<SessionHeader xmlns="urn:partner.soap.sforce.com">',
    '<sessionId>' + esc(revoke ? this.refreshToken : this.accessToken) + '</sessionId>',
    '</SessionHeader>',
    '</se:Header>',
    '<se:Body>',
    '<logout xmlns="urn:partner.soap.sforce.com"/>',
    '</se:Body>',
    '</se:Envelope>'
  ].join('');

  return this._transport.httpRequest({
    method: 'POST',
    url: [this.instanceUrl, "services/Soap/u", this.version].join('/'),
    body: body,
    headers: {
      "Content-Type": "text/xml",
      "SOAPAction": '""'
    }
  }).then(function (response) {
    logger.debug("SOAP statusCode = " + response.statusCode + ", response = " + response.body);
    if (response.statusCode >= 400) {
      var m = response.body.match(/<faultstring>([^<]+)<\/faultstring>/);
      var faultstring = m && m[1];
      throw new Error(faultstring || response.body);
    }

    // Destroy the session bound to this connection
    self.accessToken = null;
    self.userInfo = null;
    self.refreshToken = null;
    self.instanceUrl = null;
    self.cache.clear();

    // nothing useful returned by logout API, just return
    return undefined;

  }).thenCall(callback);
};





