// biome-ignore-all lint/style/useFilenamingConvention: Keep the documented adapter path stable.
import {
    defineTelemetryConfig,
    getAioRuntimeResourceWithAttributes,
    getLogger,
    getPresetInstrumentations,
    instrumentEntrypoint,
} from "@adobe/aio-lib-telemetry";
import {
    BatchLogRecordProcessor,
    OTLPLogExporterProto,
} from "@adobe/aio-lib-telemetry/otel";

const SENSITIVE_KEY =
    /password|secret|token|license.?key|authorization|credential|username|customer_id/i;
const TRAILING_SLASH = /\/$/;
let logRecordProcessor;
let missingLicenseWarningLogged = false;
let invalidEndpointWarningLogged = false;
let emittedLogRecordCount = 0;
const NEW_RELIC_OTLP_ENDPOINTS = new Map([
    ["https://otlp.nr-data.net", "https://otlp.nr-data.net:4318/v1/logs"],
    ["https://otlp.nr-data.net/v1/logs", "https://otlp.nr-data.net:4318/v1/logs"],
    [
        "https://otlp.nr-data.net:4318/v1/logs",
        "https://otlp.nr-data.net:4318/v1/logs",
    ],
    [
        "https://otlp.eu01.nr-data.net",
        "https://otlp.eu01.nr-data.net:4318/v1/logs",
    ],
    [
        "https://otlp.eu01.nr-data.net/v1/logs",
        "https://otlp.eu01.nr-data.net:4318/v1/logs",
    ],
    [
        "https://otlp.eu01.nr-data.net:4318/v1/logs",
        "https://otlp.eu01.nr-data.net:4318/v1/logs",
    ],
    ["https://otlp.jp.nr-data.net", "https://otlp.jp.nr-data.net:4318/v1/logs"],
    [
        "https://otlp.jp.nr-data.net/v1/logs",
        "https://otlp.jp.nr-data.net:4318/v1/logs",
    ],
    [
        "https://otlp.jp.nr-data.net:4318/v1/logs",
        "https://otlp.jp.nr-data.net:4318/v1/logs",
    ],
    ["https://gov-otlp.nr-data.net", "https://gov-otlp.nr-data.net:4318/v1/logs"],
    [
        "https://gov-otlp.nr-data.net/v1/logs",
        "https://gov-otlp.nr-data.net:4318/v1/logs",
    ],
    [
        "https://gov-otlp.nr-data.net:4318/v1/logs",
        "https://gov-otlp.nr-data.net:4318/v1/logs",
    ],
    [
        "https://log-api.newrelic.com/log/v1",
        "https://otlp.nr-data.net:4318/v1/logs",
    ],
    [
        "https://log-api.eu.newrelic.com/log/v1",
        "https://otlp.eu01.nr-data.net:4318/v1/logs",
    ],
    [
        "https://log-api.jp.nr-data.net/log/v1",
        "https://otlp.jp.nr-data.net:4318/v1/logs",
    ],
    [
        "https://gov-log-api.newrelic.com/log/v1",
        "https://gov-otlp.nr-data.net:4318/v1/logs",
    ],
]);

function resolveNewRelicEndpoint(endpoint) {
    const configuredEndpoint = String(endpoint || "").replace(
        TRAILING_SLASH,
        "",
    );
    const resolvedEndpoint = NEW_RELIC_OTLP_ENDPOINTS.get(configuredEndpoint);
    if (resolvedEndpoint) {
        return resolvedEndpoint;
    }
    if (configuredEndpoint && !invalidEndpointWarningLogged) {
        console.warn(
            "[new-relic] unrecognized NEW_RELIC_LOG_ENDPOINT; falling back to the US endpoint",
        );
        invalidEndpointWarningLogged = true;
    }
    return "https://otlp.nr-data.net:4318/v1/logs";
}

function describeEndpoint(endpoint) {
    try {
        const url = new URL(endpoint);
        return { host: url.host, path: url.pathname };
    } catch {
        return { host: "invalid", path: "unavailable" };
    }
}

function instrumentExporter(exporter) {
    const exportBatch = exporter.export.bind(exporter);
    exporter.export = (records, callback) => {
        const startedAt = Date.now();
        console.info("[new-relic] batch export started", {
            recordCount: records?.length ?? 0,
        });

        try {
            return exportBatch(records, (result) => {
                const succeeded = result?.code === 0;
                const details = {
                    durationMs: Date.now() - startedAt,
                    resultCode: result?.code ?? "unknown",
                    recordCount: records?.length ?? 0,
                };
                if (succeeded) {
                    console.info("[new-relic] batch export completed", details);
                } else {
                    console.error("[new-relic] batch export failed", {
                        ...details,
                        errorCode:
                            result?.error?.code ??
                            result?.error?.statusCode ??
                            "unknown",
                        errorName: result?.error?.name ?? "Error",
                    });
                }
                callback(result);
            });
        } catch (error) {
            console.error("[new-relic] batch export threw", {
                durationMs: Date.now() - startedAt,
                errorCode: error.code ?? error.statusCode ?? "unknown",
                errorName: error.name || "Error",
                recordCount: records?.length ?? 0,
            });
            throw error;
        }
    };
    return exporter;
}

function sanitize(value, key = "", depth = 0) {
    if (SENSITIVE_KEY.test(key)) {
        return "[REDACTED]";
    }
    if (value === null || typeof value !== "object") {
        return value;
    }
    if (depth >= 10) {
        return "[MAX_DEPTH]";
    }
    if (Array.isArray(value)) {
        return value.map((item) => sanitize(item, "", depth + 1));
    }
    return Object.fromEntries(
        Object.entries(value).map(([childKey, childValue]) => [
            childKey,
            sanitize(childValue, childKey, depth + 1),
        ]),
    );
}

const telemetryConfig = defineTelemetryConfig((params, isDev) => {
    const licenseKey = params.NEW_RELIC_LICENSE_KEY;
    const configuredEndpoint = params.NEW_RELIC_LOG_ENDPOINT;
    const sdkConfig = {
        instrumentations: getPresetInstrumentations("simple"),
        metricReaders: [],
        resource: getAioRuntimeResourceWithAttributes({
            "service.version": "1.0.0",
        }),
        serviceName: "checkout-tax-integration",
        spanProcessors: [],
    };

    if (licenseKey && licenseKey !== "NULL") {
        const resolvedEndpoint = resolveNewRelicEndpoint(configuredEndpoint);
        console.info("[new-relic] exporter configuration accepted", {
            endpoint: describeEndpoint(resolvedEndpoint),
            licenseKeyPresent: true,
        });
        if (!logRecordProcessor) {
            try {
                const exporter = instrumentExporter(
                    new OTLPLogExporterProto({
                        headers: { "api-key": licenseKey },
                        timeoutMillis: 1500,
                        url: resolvedEndpoint,
                    }),
                );
                logRecordProcessor = new BatchLogRecordProcessor({
                    exporter,
                    exportTimeoutMillis: 1500,
                    maxExportBatchSize: 64,
                });
                console.info("[new-relic] batch processor initialized", {
                    exportTimeoutMillis: 1500,
                    maxExportBatchSize: 64,
                });
            } catch (error) {
                console.error("[new-relic] exporter initialization failed", {
                    errorCode: error.code ?? error.statusCode ?? "unknown",
                    errorName: error.name || "Error",
                });
                throw error;
            }
        }
        sdkConfig.logRecordProcessors = [logRecordProcessor];
    } else if (!isDev && !missingLicenseWarningLogged) {
        console.warn(
            "[new-relic] log export disabled: NEW_RELIC_LICENSE_KEY is missing or NULL in action inputs",
        );
        missingLicenseWarningLogged = true;
    } else if (isDev && !missingLicenseWarningLogged) {
        console.info(
            "[new-relic] log export disabled in this invocation: license key is missing or NULL",
        );
        missingLicenseWarningLogged = true;
    }
    return {
        diagnostics: { exportLogs: false, logLevel: isDev ? "debug" : "warn" },
        sdkConfig,
    };
});

async function flushTelemetry() {
    if (!logRecordProcessor) {
        console.info("[new-relic] flush skipped", {
            reason: "batch processor is not initialized",
        });
        return;
    }
    const startedAt = Date.now();
    console.info("[new-relic] flush started");
    try {
        await logRecordProcessor.forceFlush();
        console.info("[new-relic] flush completed", {
            durationMs: Date.now() - startedAt,
        });
    } catch (error) {
        console.warn("[new-relic] telemetry log flush failed", {
            durationMs: Date.now() - startedAt,
            errorCode: error.code ?? error.statusCode ?? "unknown",
            errorName: error.name || "Error",
        });
    }
}

function createLogger(params = {}) {
    const logger = getLogger("checkout-tax-integration", {
        level: params.LOG_LEVEL || "info",
    });

    return function log(data) {
        const entry = sanitize(data);
        const { level: requestedLevel, message: logMessage, ...attributes } = entry;
        const level =
            requestedLevel === "warn" || requestedLevel === "error"
                ? requestedLevel
                : "info";
        const message = logMessage || "[oms]";
        logger[level](
            Object.keys(attributes).length
                ? `${message}\n${JSON.stringify(attributes, null, 2)}`
                : message,
        );
        emittedLogRecordCount += 1;
        console.info("[new-relic] log record emitted", {
            level,
            recordNumber: emittedLogRecordCount,
        });
    };
}

function instrumentForNewRelic(
    main,
    { exportToNewRelic = false, isSuccessful } = {},
) {
    const config = isSuccessful
        ? { ...telemetryConfig, isSuccessful }
        : telemetryConfig;
    const instrumentedEntrypoint = instrumentEntrypoint(main, config);

    return function mainWithTelemetry(params) {
        const licenseKey = params?.NEW_RELIC_LICENSE_KEY;
        const shouldExport =
            exportToNewRelic && licenseKey && licenseKey !== "NULL";
        return instrumentedEntrypoint({
            ...params,
            ...(shouldExport ? { ENABLE_TELEMETRY: true } : {}),
        });
    };
}

export {
    createLogger,
    flushTelemetry,
    instrumentForNewRelic,
    resolveNewRelicEndpoint,
    sanitize,
    telemetryConfig
};

