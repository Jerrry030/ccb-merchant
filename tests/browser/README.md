# Merchant browser regressions

Run `npm run test:browser` with an existing Playwright installation and Chromium. `PLAYWRIGHT_MODULE` may identify an installed Playwright module; `PLAYWRIGHT_EXECUTABLE_PATH` may select an existing browser. The tests do not install packages or download browsers.

The browser suites exercise the shipped UI and isolated HTTP/SQLite fixtures. They cover local setup, sessions and roles, customers, inventory, device confirmation, settings, checkout and uncertain results. Off-origin application requests are blocked; provider and mail transports use synthetic data.

Each suite owns its temporary data and browser context and closes them on completion. Screenshots, if enabled, belong in the ignored browser artifacts directory. Do not capture real customer or credential screens.

For manual UI inspection, run `node tests/browser/fixture-server.mjs` from the repository root. It prints a temporary loopback origin. Stop the fixture with Ctrl+C; never deploy it or connect it to production.

Browser results establish only the tested local behavior. They do not prove real-provider compatibility, email arrival, real payments, installed-client behavior or production deployment. Run authorized integration checks separately.
