// server/index.js
// Minimal Express server that mounts a TOMP/Bare server at /ca/
// - tries '@nebula-services/bare-server-node' first, falls back to '@tomphttp/bare-server-node'.
// - serves static files from the project root (adjust `staticRoot` if needed).
// - forwards upgrade (websocket) events to the bare server.

const path = require('path');
const http = require('http');
const express = require('express');

const staticRoot = path.resolve(__dirname, '..'); // serve project root; change if you want /public
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PROXY_PREFIX = process.env.PROXY_PREFIX || '/ca/'; // the same prefix Interstellar used

// Try to require a bare-server implementation (Nebula fork or tomphttp original)
function requireBareModule() {
  const candidates = [
    '@nebula-services/bare-server-node', // Interstellar used nebula fork
    '@tomphttp/bare-server-node',        // original tomphttp package
  ];
  for (const name of candidates) {
    try {
      const mod = require(name);
      // module might export default or a factory function directly
      return mod.default || mod;
    } catch (e) {
      // continue
    }
  }
  return null;
}

async function main() {
  const createBareServer = requireBareModule();
  if (!createBareServer) {
    console.error(
      'No bare-server package found. Please `npm i @nebula-services/bare-server-node` or `npm i @tomphttp/bare-server-node`.'
    );
    process.exit(1);
  }

  // If the module is the CLI entry (e.g. exports run function), the factory might still be the default.
  // Most versions support createBareServer(prefix) or createBareServer({ prefix })
  let bareServer;
  try {
    // Common usage: createBareServer('/ca/')
    bareServer = createBareServer(PROXY_PREFIX);
  } catch (err) {
    // fallback: try object API
    try {
      bareServer = createBareServer({ prefix: PROXY_PREFIX });
    } catch (err2) {
      console.error('createBareServer failed:', err, err2);
      process.exit(1);
    }
  }

  const app = express();

  // Optional: basic logging
  app.use((req, res, next) => {
    console.log(`${req.method} ${req.url}`);
    next();
  });

  // Serve static files from project root (index.html, uv/ etc.)
  app.use(express.static(staticRoot, {
    // adjust caching headers if you want
  }));

  // If the bareServer exposes a handler function for http requests, mount it:
  // Some implementations return an express-like handler; attempt to mount it at the prefix.
  if (typeof bareServer === 'function') {
    // mount as middleware for requests starting with PROXY_PREFIX
    app.use(PROXY_PREFIX, (req, res, next) => bareServer(req, res, next));
  } else if (bareServer && typeof bareServer.middleware === 'function') {
    // some libs provide a named middleware
    app.use(PROXY_PREFIX, bareServer.middleware());
  } else {
    // If no middleware exposed, we will rely on raw http 'upgrade' and raw request handling by bareServer.attach or bareServer.handle
    // We'll still fall through to creating the http server and attaching upgrades below.
    console.log('Bare server did not provide middleware — attaching via raw http server upgrade/emit (if supported).');
  }

  const server = http.createServer(app);

  // If the bareServer provides an 'upgrade' or 'handleUpgrade' function we must forward upgrade events:
  // Common method names used across implementations: handleUpgrade, onUpgrade, upgrade
  server.on('upgrade', (req, socket, head) => {
    // Try different API shapes
    if (bareServer && typeof bareServer.handleUpgrade === 'function') {
      return bareServer.handleUpgrade(req, socket, head);
    }
    if (bareServer && typeof bareServer.upgrade === 'function') {
      return bareServer.upgrade(req, socket, head);
    }
    // fallback: if the bareServer returned a function that accepts (req, socket, head)
    if (typeof bareServer === 'function') {
      try {
        return bareServer(req, socket, head); // some libs accept raw upgrade
      } catch (e) {
        // ignore and close socket
      }
    }

    // If not handled, close the socket
    socket.write('HTTP/1.1 400 Bad Request\\r\\n\\r\\n');
    socket.destroy();
  });

  // Some bare server libs expect to be attached to the http server. Try common attach points:
  if (bareServer && typeof bareServer.listen === 'function') {
    try {
      // allow bareServer to attach internal listeners if it wants (safe no-op for many libs)
      bareServer.listen(server);
    } catch (e) {
      // ignore if not supported
    }
  } else if (bareServer && typeof bareServer.attach === 'function') {
    try { bareServer.attach(server); } catch(e) {}
  }

  server.listen(PORT, HOST, () => {
    console.log(`Server listening: http://${HOST}:${PORT}  (serving static root: ${staticRoot})`);
    console.log(`Bare proxy prefix: ${PROXY_PREFIX}`);
  });
}

main().catch(err => {
  console.error('Fatal server error', err);
  process.exit(1);
});
