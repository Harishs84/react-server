var renderMiddleware = require("../renderMiddleware"),
	express = require("express"),
	expressState = require('express-state'),
	http = require("http"),
	fs = require("fs"),
	mkdirp = require("mkdirp"),
	webpack = require("webpack"),
	Browser = require('zombie');

var PORT = process.env.PORT || 8769;

var servers = []; 

function getBrowser(opts) {
	var browser = new Browser(opts);
	browser.silent = true;
	return browser;
}

var writeRoutesFile = (routes, tempDir) => {
	// first we convert our simple routes format to a triton routes file.
	var routesForTriton = `module.exports = {
			middleware: [require("../client/spec/test-runtime/ScriptsMiddleware")],
			routes: {`;

	Object.keys(routes).forEach((url, index) => {
		routesForTriton += `
			route${index}: {
				path: ["${url}"],
				method: 'get',
				page: function () {
					return {
						done: function (cb) {
							cb(require("../client/spec/${routes[url]}"));
						}
					};
				}				
			},`;
	});

	// make sure we add a route for a page that will let us do client-side
	// transitions.
	routesForTriton += `
		transitionPage: {
			path: ["/__transition"],
			method: "get",
			page: function() {
				return {
					done: function(cb) {
						cb(require("../client/spec/test-runtime/TransitionPage"));
					}
				};
			}
		}}};`;
	mkdirp.sync(tempDir);
	fs.writeFileSync(tempDir + "/routes.js", routesForTriton);
}

var writeEntrypointFile = (tempDir) => {
	mkdirp.sync(tempDir);
	fs.writeFileSync(tempDir + "/entrypoint.js", `
		var ClientController = require("triton").ClientController;

		window.rfBootstrap = function () {
			var controller = new ClientController({
				routes: require("./routes.js")
			});
			
			controller.init();
		};`
	);	
}


var buildClientCode = (tempDir, cb) => {

	webpack({
		context: tempDir,
		entry: "./entrypoint.js",
		output: {
			path: tempDir,
			filename: "rollup.js"
		},
		resolve: {
			alias: {
				"triton": process.cwd()  // this works because package.json points it at /target/client/client.js
			}
		}
	}, function(err, stats) {
	    if(err) throw new Error("Error during webpack build.", err);
	    cb();
	});
}

// starts a simple triton server.
// routes is of the form {url: pathToPageCode}
var startTritonServer = (routes, cb) => {

	var testTempDir = __dirname + "/../../test-temp";
	writeRoutesFile(routes, testTempDir);
	writeEntrypointFile(testTempDir);
	buildClientCode(testTempDir, () => {
		var server = express();
		process.env.R3S_CONFIGS = process.cwd() + "/target/config/dev"

		server.use('/rollups', express.static(testTempDir));

		// we may have changed the routes file since the last test run, so the old 
		// routes file may be in the require cache. this code may not be ideal in node
		// (mucking with the require cache); if it causes problems, we should change the code
		// to add a hash to the end of the module name.
		delete require.cache[require.resolve(testTempDir + "/routes")]
		renderMiddleware(server, require(testTempDir + "/routes"));
		var httpServer = http.createServer(server);
		httpServer.listen(PORT, () => cb(httpServer));

	});
};

var stopTritonServer = (server, done) => {
	server.close(done);
};

var getServerBrowser = (url, cb) => {
	var browser = getBrowser({runScripts:false});

	browser.visit(`http://localhost:${PORT}${url}`).then(() => cb(browser));
}

var getClientBrowser = (url, cb) => {
	var browser = getBrowser();
	browser.visit(`http://localhost:${PORT}${url}`).then(() => cb(browser));
};

var getTransitionBrowser = (url, cb) => {
	var browser = getBrowser();
	// go to the transition page and click the link.
	browser.visit(`http://localhost:${PORT}/__transition?url=${url}`).then(() => {
		browser.clickLink("Click me", () => {
			cb(browser.window);
		});
	});

}

// vists the url `url` and calls `cb` with the browser's window
// object after the page has completely downloaded from the server but before any client
// JavaScript has run. note that this is useful for examining the structure of the
// server-generated HTML via `window.document`, but it is not generally useful to do 
// much else with the window object, as no JavaScript has run on the client (i.e.
// React will not be present, and nothing will be interactive.).
var getServerWindow = (url, cb) => { getServerBrowser(url, (browser) => cb(browser.window)); }

// vists the url `url` and calls `cb` with the browser's window
// object after the page has completely downloaded from the server and all client
// JavaScript has run. at this point, the page will have re-rendered, and 
// it will be interactive.
var getClientWindow = (url, cb) => { getClientBrowser(url, (browser) => cb(browser.window)); };

// vists the url `url` via a client-side transition, and calls `cb` 
// with the browser's window object after the page has completely run all client
// JavaScript. at this point, the page will have transitioned and rendered, and 
// it will be interactive.
var getTransitionWindow = (url, cb) => { getTransitionBrowser(url, (browser) => cb(browser.window)); };

// vists the url `url` and calls `cb` with the browser's document
// object after the page has completely downloaded from the server but before any client
// JavaScript has run. this is the right method to use to run assertions on the server-
// generated HTML.
var getServerDocument = (url, cb) => { getServerWindow(url, (window) => cb(window.document)); };

// vists the url `url` and calls `cb` with the browser's document
// object after the page has completely downloaded from the server and all client
// JavaScript has run. this is the right method to use to run assertions on the HTML
// after client-side rendering has completed.
var getClientDocument = (url, cb) => { getClientWindow(url, (window) => cb(window.document)); };


// vists the url `url` via a client-side transition, and calls `cb` 
// with the browser's document object after the page has completely run all client
// JavaScript. this is the right method to use to run assertions on the HTML
// after a client-side transition has completed.
var getTransitionDocument = (url, cb) => { getTransitionWindow(url, (window) => cb(window.document)); };

// used to test the JS internals of a page both on client load and on page-to-page
// transition. this does NOT test server load, since JS doesn't run on that. if you just
// want to test document structure, including server generated documents, use testWithDocument.
// testFn's first argument will be the window object. if it takes a second argument, it will be
// a done callback for async tests.
var testWithWindow = (url, testFn) => {
	var callback = (document, done) => {
		if (testFn.length >= 2) {
			testFn(document, done);
		} else {
			// the client doesn't want the done function, so we should call it.
			testFn(document);
			done();
		}
	}
	it ("on client", function(done) {
		getClientWindow(url, (window) => {
			callback(window, done);
		});
	});
	it ("on transition", function(done) {
		getTransitionWindow(url, (window) => {
			callback(window, done);
		});
	});

}

// used to test document structure on server, on client, and on page-to-page transition.
// this method creates three Jasmine tests. this method should not test anything that is 
// dependent on the page JS running. if you want to test the internal state of the JS, use
// testWithWindow.
// testFn's first argument will be the document object. if it takes a second argument, it will be
// a done callback for async tests.
var testWithDocument = (url, testFn) => {
	var callback = (document, done) => {
		if (testFn.length >= 2) {
			testFn(document, done);
		} else {
			// the client doesn't want the done function, so we should call it.
			testFn(document);
			done();
		}
	}
	it ("on server", function(done) {
		getServerDocument(url, (document) => {
			callback(document, done);
		});
	});
	it ("on client", function(done) {
		getClientDocument(url, (document) => {
			callback(document, done);
		});
	});
	it ("on transition", function(done) {
		getTransitionDocument(url, (document) => {
			callback(document, done);
		});
	});

}

var testSetupFn = (routes) => {
	return (done) => {
		startTritonServer(routes, s => {
			servers.push(s); 
			done();
		});
	}
}

var testTeardownFn = (done) => {
	stopTritonServer(servers.pop(), done);
};

// convenience function to start a triton server before each test. make sure to 
// call stopTritonAfterEach so that the server is stopped.
var startTritonBeforeEach = (routes) => {
	beforeEach(testSetupFn(routes));
}

// convenience function to start a triton server before all the tests. make sure to 
// call stopTritonAfterEach so that the server is stopped.
var startTritonBeforeAll = (routes) => {
	beforeAll(testSetupFn(routes));
}

// convenience function to stop a triton server after each test. to be paired
// with startTritonBeforeEach.
var stopTritonAfterEach = () => {
	afterEach(testTeardownFn);
}

// convenience function to stop a triton server after all the tests. to be paired
// with startTritonBeforeAll.
var stopTritonAfterAll = () => {
	afterAll(testTeardownFn);
}

module.exports = {
	startTritonServer, 
	stopTritonServer, 
	getServerDocument,
	getClientDocument,
	getTransitionDocument,
	testWithDocument,
	// getServerBrowser,  <-- not exposed because it's generally not useful to get window when client JS hasn't run.
	getClientBrowser,
	getTransitionBrowser,
	// getServerWindow,  <-- not exposed because it's generally not useful to get window when client JS hasn't run.
	getClientWindow,
	getTransitionWindow,
	testWithWindow,
	startTritonBeforeEach,
	stopTritonAfterEach,
	startTritonBeforeAll,
	stopTritonAfterAll
};
