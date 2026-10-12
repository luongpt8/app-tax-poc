# Integrating `aioTelemetry.js`

This guide explains how to use `actions/lib/aioTelemetry.js` to send structured App Builder action logs to New Relic through `@adobe/aio-lib-telemetry`.

## Prerequisites

- Adobe I/O Runtime actions using Node.js 22 through 24. Version `@adobe/aio-lib-telemetry@1.3.0` declares this runtime range.
- A New Relic license/ingest key.
- Network access from the action runtime to the New Relic OTLP endpoint.

Install the library when integrating the adapter into another project:

```bash
npm install @adobe/aio-lib-telemetry@^1.3.0
```

This repository already declares the dependency.

## Configure New Relic

For local `aio app dev` or a manual deploy, put the values in the project-root `.env`. For GitHub Actions, add `NEW_RELIC_LICENSE_KEY` as a secret and `NEW_RELIC_LOG_ENDPOINT` as a variable in the GitHub Environment used by the deploy job (this repository uses `stage`). The job must declare that environment, and the deploy step must expose both values to the CLI. Never commit or print the license key.

```dotenv
NEW_RELIC_LICENSE_KEY=your-new-relic-license-key
NEW_RELIC_LOG_ENDPOINT=https://otlp.nr-data.net/v1/logs
```

For GitHub Actions, the deploy job must select the GitHub Environment that holds the values, then expose them to the CLI step:

```yaml
jobs:
  deploy:
    environment: stage
    steps:
      - name: Deploy
        env:
          NEW_RELIC_LICENSE_KEY: ${{ secrets.NEW_RELIC_LICENSE_KEY }}
          NEW_RELIC_LOG_ENDPOINT: ${{ vars.NEW_RELIC_LOG_ENDPOINT }}
        uses: adobe/aio-apps-action@<version>
        with:
          command: deploy
```

The Runtime manifest maps these values into action inputs. Adobe Runtime supplies them in `params`; Commerce does not send them in the request body. `.env` is used by the CLI during a manual deploy and is not uploaded as a file.

```yaml
runtimeManifest:
  packages:
    tax-integration:
      actions:
        collect-taxes:
          inputs:
            ENABLE_TELEMETRY: true
            NEW_RELIC_LICENSE_KEY: $NEW_RELIC_LICENSE_KEY
            NEW_RELIC_LOG_ENDPOINT: $NEW_RELIC_LOG_ENDPOINT
```

The adapter maps accepted regional URLs to its OTLP HTTP/Protobuf export URLs:

| Region | Accepted endpoint value | Export URL |
| --- | --- | --- |
| US | `https://otlp.nr-data.net/v1/logs` | `https://otlp.nr-data.net/v1/logs` |
| EU | `https://otlp.eu01.nr-data.net/v1/logs` | `https://otlp.eu01.nr-data.net:4318/v1/logs` |
| Japan | `https://otlp.jp.nr-data.net/v1/logs` | `https://otlp.jp.nr-data.net:4318/v1/logs` |
| US FedRAMP | `https://gov-otlp.nr-data.net/v1/logs` | `https://gov-otlp.nr-data.net:4318/v1/logs` |

The adapter also accepts the listed hosts without a path, explicit `:4318/v1/logs` forms, and legacy New Relic Log API URLs listed in `NEW_RELIC_OTLP_ENDPOINTS`. An unset endpoint uses the US default. An unrecognized non-empty endpoint writes a warning and falls back to the US endpoint, so check the Runtime log for `[new-relic] unrecognized NEW_RELIC_LOG_ENDPOINT`.

## Instrument an Action

`aioTelemetry.js` does not depend on `http.js`. For a standalone action, create the logger inside the instrumented entrypoint and flush it in `finally`:

```js
import {
  createLogger,
  flushTelemetry,
  instrumentForNewRelic
} from '../lib/aioTelemetry.js'

async function main(params) {
  const log = createLogger(params)
  try {
    log({
      message: 'Tax quote received',
      level: 'info',
      itemCount: Array.isArray(params.items) ? params.items.length : 0,
      data: { requestId: params.requestId, items: params.items }
    })
    return { statusCode: 200, body: { success: true } }
  } finally {
    await flushTelemetry()
  }
}

export const main = instrumentForNewRelic(main, { exportToNewRelic: true })
```

The wrapper enables `ENABLE_TELEMETRY` when `exportToNewRelic` is enabled and receives a non-empty `NEW_RELIC_LICENSE_KEY`. `createLogger(params)` returns a `log(data)` function. Supported levels are `info`, `warn`, and `error`; other values, including `debug`, are logged as `info`.

### Add Data to a Log

Put nested objects or arrays in a property such as `data`. The adapter sanitizes the entry, then pretty-prints its remaining fields as JSON in the log message. This keeps deeply nested values readable instead of displaying them as `[Object]` or `[Array]`:

```js
log({
  message: 'Tax request payload',
  level: 'info',
  data: taxRequest
})
```

The serialized fields are part of the log message body, not separate New Relic attributes. Pass objects directly; do not call `JSON.stringify()` at the call site.

The `finally` block awaits `flushTelemetry()` so the batch processor is flushed before the action completes. Continue to use the existing `logger.js` for actions that have not been migrated.

### Optional: Existing Shared Endpoint Helper

If your project already has an endpoint helper (for example, this repository's `actions/lib/http.js`), it can own request validation, response formatting, and the flush lifecycle. Wire the adapter into that helper with a logger factory and a flush callback:

```js
import { endpoint } from '../lib/http.js'
import { createLogger, flushTelemetry, instrumentForNewRelic } from '../lib/aioTelemetry.js'

export const main = instrumentForNewRelic(endpoint({
  method: 'POST',
  loggerFactory: createLogger,
  flushLogs: flushTelemetry,
  handler: async (params, log) => {
    log({ message: '[example] request processed', level: 'info' })
    return { success: true }
  }
}), { exportToNewRelic: true })
```

`http.js` is only an example helper; adapt the wiring to the abstractions already present in your project. Continue to use the existing `logger.js` for actions that have not been migrated.

## Telemetry Configuration in This App

This app has two telemetry paths; changing one does not automatically update the other:

| Action | Configuration | Current export behavior |
| --- | --- | --- |
| `collect-taxes` | `actions/lib/aioTelemetry.js`, via `instrumentForNewRelic()` | Application logs use the dedicated New Relic OTLP log exporter when the action receives a non-empty license key. Trace and metric exporters are not configured. |
| `collect-adjustment-taxes` | `src/commerce-extensibility-1/actions/telemetry.js`, via `instrumentEntrypoint()` | Uses the shared Adobe telemetry configuration and service resource. It does not use the New Relic log adapter. `metricReaders: []` and `spanProcessors: []` disable metric and trace export. |

`checkout-metrics.js` defines counters for both actions, but a configuration with no metric readers does not export those counters. To send `collect-adjustment-taxes` logs to New Relic, migrate that action to `aioTelemetry.js`, add the New Relic action inputs in `ext.config.yaml`, and flush its dedicated logger before the action returns.

## Trace and Service Identity

`instrumentEntrypoint()` creates the action's telemetry context. Before context extraction, `instrumentForNewRelic()` normalizes the incoming `traceparent` in `params.__ow_headers`: comma-joined or repeated values are reduced to the first valid W3C value, and invalid values are discarded. The tax action does not manually copy the raw header to its `fetch` request. The Undici instrumentation injects one outbound child `traceparent` (same trace ID, new span ID). A `[trace] incoming traceparent values normalized` Runtime warning reports counts only, never the header value.

For `collect-taxes`, New Relic logs use a dedicated `LoggerProvider`, separate from Adobe's global LoggerProvider lifecycle, so a warm action process cannot silently route them through an already-initialized provider without the New Relic exporter. Trace spans and metrics are not exported by this adapter. Logs use `checkout-tax-integration` as their service name and logger scope; changing it causes New Relic to show a different service identity.

## Data Safety

The current `SENSITIVE_KEY` pattern redacts keys matching password, secret, token, license key, authorization, credential, username, and customer ID. It does not redact every kind of PII, such as email, names, street, or other address fields. Avoid logging raw quote payloads in production; prefer allowlisted fields such as item counts and status. If full payload logging is needed for a controlled diagnostic, extend and test the sanitizer for the data involved, then remove that logging afterward.

Never log the license key. The adapter uses it only in the OTLP `api-key` header.

## Build, Run, and Verify

Build the actions and start the local development server:

```bash
aio app build --force-build --no-web-assets
aio app dev
```

Restart `aio app dev` after changing telemetry configuration or exporter code. The telemetry SDK is global to the action process; hot reload can leave an already-initialized SDK using the previous configuration.

Run the focused action tests:

```bash
npx vitest run test/actions/collect-taxes.test.js
```

Then invoke the action with a valid request and, when trace correlation is needed, a valid `traceparent` header. In New Relic Logs, check the service identity, log body, and trace ID. A successful API response alone does not prove that New Relic ingested the logs.

## Runtime Export Diagnostics

The adapter writes `[new-relic]` diagnostics to the Adobe Runtime action logs. Follow these messages in order:

1. `exporter configuration accepted` means a non-empty license key was received. The endpoint is reported as host and path only; the key is never logged.
2. `batch processor initialized` means the OTLP exporter and batch processor were constructed.
3. `log record emitted` means the application logger handed a record to the dedicated New Relic LoggerProvider's batch processor. It does not yet confirm export.
4. `batch export started` reports how many records are in the outgoing batch. `batch export completed` with `resultCode: 0` means the OTLP exporter received a successful response. `batch export failed` or `batch export threw` includes only a safe error name/code.
5. `flush completed` means the action finished flushing pending telemetry. `flush skipped` means no batch processor was configured.

If `log export disabled` appears, check the action's `NEW_RELIC_LICENSE_KEY` input. If `unrecognized NEW_RELIC_LOG_ENDPOINT` appears, correct that input; the adapter falls back to the US endpoint. `Telemetry SDK already initialized, skipping telemetry initialization` is emitted by Adobe's global SDK on warm invocations and does not control the dedicated New Relic logger.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Logs appear in Adobe Runtime output but not New Relic | Confirm the action receives `NEW_RELIC_LICENSE_KEY` and `NEW_RELIC_LOG_ENDPOINT`, and that `exportToNewRelic` is enabled. Check the OTLP diagnostics in the Runtime output. |
| `Cannot read properties of undefined (reading 'export')` | `BatchLogRecordProcessor` requires an options object containing `exporter`. Rebuild the action and restart the dev server so the running bundle contains that constructor call. |
| Export timeout after changing source | Compare the stack-trace bundle path with the newly built action and restart `aio app dev`. The process may still be using an older bundle or initialized SDK. Do not treat a larger timeout as a substitute for checking the running bundle and endpoint. |
| Logs are under an unexpected service in New Relic | Check the `serviceName` and logger name in `aioTelemetry.js`; the tax integration uses `checkout-tax-integration`. |
| TLS error when invoking local `https://localhost:9080` | Local development may use a self-signed certificate. Use a trusted local certificate, or use `curl --insecure` only for a local diagnostic request. |