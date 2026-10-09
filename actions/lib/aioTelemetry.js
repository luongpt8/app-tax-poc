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
    return (
        NEW_RELIC_OTLP_ENDPOINTS.get(
            String(endpoint || "").replace(TRAILING_SLASH, ""),
        ) || "https://otlp.nr-data.net:4318/v1/logs"
    );
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
    const sdkConfig = {
        instrumentations: getPresetInstrumentations("simple"),
        resource: getAioRuntimeResourceWithAttributes({
            "service.version": "1.0.0",
        }),
        serviceName: "checkout-tax-integration",
    };

    if (licenseKey && licenseKey !== "NULL") {
        if (!logRecordProcessor) {
            const exporter = new OTLPLogExporterProto({
                headers: { "api-key": licenseKey },
                timeoutMillis: 1500,
                url: resolveNewRelicEndpoint(params.NEW_RELIC_LOG_ENDPOINT),
            });
            logRecordProcessor = new BatchLogRecordProcessor({
                exporter,
                exportTimeoutMillis: 1500,
                maxExportBatchSize: 64,
            });
        }
        sdkConfig.logRecordProcessors = [logRecordProcessor];
    }
    return {
        diagnostics: { exportLogs: false, logLevel: isDev ? "debug" : "warn" },
        sdkConfig,
    };
});

async function flushTelemetry() {
    if (!logRecordProcessor) {
        return;
    }
    try {
        await logRecordProcessor.forceFlush();
    } catch (error) {
        console.warn("[new-relic] telemetry log flush failed", {
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

