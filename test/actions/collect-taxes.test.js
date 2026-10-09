import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const telemetryState = vi.hoisted(() => ({
  exportedBatches: [],
  exporterOptions: [],
}));

vi.mock("@adobe/aio-commerce-lib-config", () => ({
  byCodeAndLevel: vi.fn((code, level) => ({ code, level })),
  getConfigurationByKey: vi.fn(),
  initialize: vi.fn(),
}));

vi.mock("@adobe/aio-lib-telemetry/otel", () => {
  function TestOTLPLogExporter(options) {
    telemetryState.exporterOptions.push(options);
  }
  TestOTLPLogExporter.prototype.export = function exportLogs(
    records,
    callback,
  ) {
    telemetryState.exportedBatches.push(records);
    callback({ code: 0 });
  };

  function TestBatchLogRecordProcessor({ exporter }) {
    this.exporter = exporter;
    this.records = [];
  }

  TestBatchLogRecordProcessor.prototype.onEmit = function onEmit(record) {
    this.records.push(record);
  };

  TestBatchLogRecordProcessor.prototype.forceFlush =
    async function forceFlush() {
      const records = this.records.splice(0);
      if (records.length === 0) {
        return;
      }
      await new Promise((resolve, reject) => {
        this.exporter.export(records, (result) => {
          if (result.code === 0) {
            resolve();
          } else {
            reject(result.error ?? new Error("test export failed"));
          }
        });
      });
    };

  function TestLoggerProvider({ processors }) {
    this.processor = processors[0];
  }

  TestLoggerProvider.prototype.getLogger = function getLogger() {
    return {
      emit: (record) => this.processor.onEmit(record),
    };
  };

  TestLoggerProvider.prototype.forceFlush = function forceFlush() {
    return this.processor.forceFlush();
  };

  return {
    BatchLogRecordProcessor: TestBatchLogRecordProcessor,
    LoggerProvider: TestLoggerProvider,
    OTLPLogExporterProto: TestOTLPLogExporter,
    SeverityNumber: { ERROR: 17, INFO: 9, WARN: 13 },
    ValueType: { DOUBLE: 0, INT: 1 },
  };
});

const { getConfigurationByKey } = await import(
  "@adobe/aio-commerce-lib-config"
);
const { main } = await import(
  "../../src/commerce-extensibility-1/actions/collect-taxes/index.js"
);

// @adobe/aio-lib-telemetry's getInstrumentationHelpers() requires ENABLE_TELEMETRY on the params
// passed to the instrumented entrypoint — mirroring the ENABLE_TELEMETRY action input configured
// in ext.config.yaml. With require-adobe-auth: true (no raw-http), Runtime parses the JSON body
// directly into `params`, so `oopQuote` arrives as a top-level key, not a base64 __ow_body.
function buildParams(oopQuote, headers) {
  return {
    AIO_COMMERCE_CONFIG_ENCRYPTION_KEY: "encryption-key",
    ENABLE_TELEMETRY: true,
    oopQuote,
    ...(headers ? { __ow_headers: headers } : {}),
  };
}

describe("collect-taxes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConfigurationByKey.mockImplementation(async (key) => ({
      config: {
        value: {
          "mock-data-api-endpoint": "/api/v1/web/commerce-poc/tax-calculate",
          "mock-data-api-key": "secret-key",
          "mock-data-base-url": "https://example.test",
        }[key],
      },
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: async () => ({
          items: [
            {
              sku: "7283C001",
              tax_amount: 19.36,
              tax_details: [
                {
                  amount: 12.1,
                  code: "SALES_TAX_CODE_1",
                  rate: 5,
                  title: "Sales Tax Code 1",
                },
                {
                  amount: 7.26,
                  code: "SALES_TAX_CODE_2",
                  rate: 3,
                  title: "Sales Tax Code 2",
                },
              ],
              taxable_amount: 241.99,
            },
          ],
          shipping_tax_amount: 0.4,
          success: true,
        }),
        ok: true,
      }),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  test("skips tax collection and service credentials when the app is disabled", async () => {
    getConfigurationByKey.mockResolvedValue({ config: { value: false } });

    const result = await main(buildParams(undefined));

    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({ op: "success" });
    expect(fetch).not.toHaveBeenCalled();
    expect(getConfigurationByKey).toHaveBeenCalledTimes(1);
    expect(getConfigurationByKey).toHaveBeenCalledWith("app-enabled", {
      code: "global",
      level: "global",
    });
  });

  test.each([true, undefined])(
    "collects taxes when app-enabled is %s",
    async (enabled) => {
      getConfigurationByKey.mockResolvedValueOnce({
        config: { value: enabled },
      });
      fetch.mockResolvedValue({
        json: async () => ({ items: [], success: true }),
        ok: true,
      });

      const result = await main(
        buildParams({ items: [], ship_to_address: {} }),
      );

      expect(result.statusCode).toBe(200);
      expect(result.body).toEqual([]);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  test("sends quote fields and maps external product and shipping taxes", async () => {
    const traceparent =
      "00-e992f3d72ad8e116f54eb7e50c3807a8-24a1ee2c5aa0d696-01";
    const result = await main(
      buildParams(
        {
          items: [
            {
              custom_attributes: { tax_code: "BOX_TAX" },
              discount_amount: 100,
              is_tax_included: false,
              quantity: 1,
              sku: "7283C001",
              tax_class: "Box Tax",
              type: "product",
              unit_price: "341.991000",
            },
            { quantity: 1, type: "shipping", unit_price: 5 },
          ],
          ship_to_address: {
            city: "Bronx",
            country: "US",
            postcode: "80239",
            region_code: "CA",
          },
        },
        { traceparent },
      ),
    );

    const [url, options] = fetch.mock.calls[0];
    expect(url.toString()).toBe(
      "https://example.test/api/v1/web/commerce-poc/tax-calculate",
    );
    expect(options.headers.Authorization).toBe("Basic secret-key");
    expect(options.headers.traceparent).toBe(traceparent);
    expect(JSON.parse(options.body)).toEqual({
      currency: "USD",
      discount_amount: 100,
      items: [
        {
          quantity: 1,
          sku: "7283C001",
          tax_class: "BOX_TAX",
          unit_price: 341.991,
        },
      ],
      shipping_address: {
        city: "Bronx",
        country_code: "US",
        postal_code: "80239",
        region: "CA",
      },
      shipping_amount: 5,
    });
    expect(result.statusCode).toBe(200);
    expect(result.body).toContainEqual(
      expect.objectContaining({
        op: "add",
        path: "oopQuote/items/0/tax_breakdown",
        value: expect.objectContaining({
          data: expect.objectContaining({
            amount: 12.1,
            code: "SALES_TAX_CODE_1",
          }),
        }),
      }),
    );
    expect(result.body).toContainEqual(
      expect.objectContaining({
        op: "add",
        path: "oopQuote/items/0/tax_breakdown",
        value: expect.objectContaining({
          data: expect.objectContaining({
            amount: 7.26,
            code: "SALES_TAX_CODE_2",
          }),
        }),
      }),
    );
    expect(result.body).toContainEqual(
      expect.objectContaining({
        op: "replace",
        path: "oopQuote/items/0/tax",
        value: expect.objectContaining({
          data: expect.objectContaining({ amount: 19.36, rate: 8 }),
        }),
      }),
    );
    expect(result.body).toContainEqual(
      expect.objectContaining({
        op: "replace",
        path: "oopQuote/items/1/tax",
        value: expect.objectContaining({
          data: expect.objectContaining({ amount: 0.4, rate: 8 }),
        }),
      }),
    );
  });

  test("matches API tax amounts to the original SKU when results are reordered", async () => {
    fetch.mockResolvedValue({
      json: async () => ({
        items: [
          {
            sku: "RF24-105-F4",
            tax_amount: 101.18,
            tax_details: [],
            taxable_amount: 1264.8,
          },
          {
            sku: "EOS-R5",
            tax_amount: 194.66,
            tax_details: [],
            taxable_amount: 2433.2,
          },
        ],
        success: true,
      }),
      ok: true,
    });
    const result = await main(
      buildParams({
        items: [
          {
            quantity: 1,
            sku: "EOS-R5",
            tax_class: "TAXABLE_GOODS",
            type: "product",
            unit_price: 2499,
          },
          {
            quantity: 1,
            sku: "RF24-105-F4",
            tax_class: "TAXABLE_GOODS",
            type: "product",
            unit_price: 1299,
          },
        ],
        ship_to_address: {
          city: "Irvine",
          country: "US",
          postcode: "92618",
          region_code: "CA",
        },
      }),
    );

    expect(JSON.parse(fetch.mock.calls[0][1].body).items).toEqual([
      {
        quantity: 1,
        sku: "EOS-R5",
        tax_class: "TAXABLE_GOODS",
        unit_price: 2499,
      },
      {
        quantity: 1,
        sku: "RF24-105-F4",
        tax_class: "TAXABLE_GOODS",
        unit_price: 1299,
      },
    ]);
    expect(result.body).toEqual([
      expect.objectContaining({
        path: "oopQuote/items/0/tax",
        value: {
          data: { amount: 194.66, discount_compensation_amount: 0, rate: 8 },
        },
      }),
      expect.objectContaining({
        path: "oopQuote/items/1/tax",
        value: {
          data: { amount: 101.18, discount_compensation_amount: 0, rate: 8 },
        },
      }),
    ]);
  });

  test("fails closed when the tax service is unavailable", async () => {
    fetch.mockResolvedValue({ ok: false, status: 503 });
    const result = await main(buildParams({ items: [], ship_to_address: {} }));
    expect(result.body).toEqual(expect.objectContaining({ op: "exception" }));
  });

  test.each([
    [400, "INVALID_REQUEST", "A required field or item value is invalid."],
    [400, "INVALID_ADDRESS", "The tax address is invalid or unsupported."],
    [401, "UNAUTHORIZED", "Basic credentials are missing or invalid."],
    [500, "TAX_CALCULATION_FAILED", "The tax calculation failed."],
    [500, "INTERNAL_ERROR", "An unexpected server error occurred."],
  ])(
    "returns %s %s from the tax service as a Commerce exception",
    async (status, code, message) => {
      fetch.mockResolvedValue({
        json: async () => ({ code, message }),
        ok: false,
        status,
      });

      const result = await main(
        buildParams({ items: [], ship_to_address: {} }),
      );

      expect(result.statusCode).toBe(200);
      expect(result.body).toEqual({
        message: `Server error: Tax service HTTP ${status} ${code}: ${message}`,
        op: "exception",
      });
    },
  );

  test("recognizes a nested error code without exposing upstream credentials", async () => {
    fetch.mockResolvedValue({
      json: async () => ({
        error: { code: "UNAUTHORIZED", message: "Basic secret-key" },
      }),
      ok: false,
      status: 401,
    });

    const result = await main(buildParams({ items: [], ship_to_address: {} }));

    expect(result.body.message).toBe(
      "Server error: Tax service HTTP 401 UNAUTHORIZED: Basic credentials are missing or invalid.",
    );
    expect(result.body.message).not.toContain("secret-key");
  });

  test("uses the HTTP status when the tax service returns a non-JSON error", async () => {
    fetch.mockResolvedValue({
      json: () => Promise.reject(new SyntaxError("Invalid JSON")),
      ok: false,
      status: 500,
    });

    const result = await main(buildParams({ items: [], ship_to_address: {} }));

    expect(result.body).toEqual({
      message: "Server error: Tax service returned HTTP 500",
      op: "exception",
    });
  });

  test("does not accept incomplete tax calculations as zero tax", async () => {
    fetch.mockResolvedValue({
      json: async () => ({
        items: [
          {
            sku: "7283C001",
            tax_amount: null,
            tax_details: [],
            taxable_amount: 241.99,
          },
        ],
        shipping_tax_amount: 0.4,
        success: true,
      }),
      ok: true,
    });
    const result = await main(
      buildParams({
        items: [{ sku: "7283C001", type: "product" }],
        ship_to_address: { country: "US" },
      }),
    );
    expect(result.body).toEqual(expect.objectContaining({ op: "exception" }));
  });

  test("does not send credentials to a different API origin", async () => {
    const configuredValues = {
      "mock-data-api-endpoint": "https://unexpected.test/tax-calculate",
      "mock-data-api-key": "secret-key",
      "mock-data-base-url": "https://example.test",
    };
    getConfigurationByKey.mockImplementation(async (key) => ({
      config: { value: configuredValues[key] },
    }));
    const result = await main(buildParams({ items: [], ship_to_address: {} }));
    expect(fetch).not.toHaveBeenCalled();
    expect(result.body).toEqual(expect.objectContaining({ op: "exception" }));
  });

  test("returns an exception operation on unexpected error", async () => {
    const result = await main(buildParams(undefined));

    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual(expect.objectContaining({ op: "exception" }));
  });

  test("exports records when the global telemetry SDK was initialized earlier", async () => {
    const quote = {
      items: [
        {
          quantity: 1,
          sku: "7283C001",
          tax_class: "Box Tax",
          type: "product",
          unit_price: 100,
        },
      ],
      ship_to_address: {
        city: "Bronx",
        country: "US",
        postcode: "80239",
        region_code: "CA",
      },
    };

    await main(buildParams(quote));
    telemetryState.exportedBatches.length = 0;
    telemetryState.exporterOptions.length = 0;
    const params = {
      ...buildParams(quote),
      NEW_RELIC_LICENSE_KEY: "test-license-key",
      NEW_RELIC_LOG_ENDPOINT: "https://otlp.nr-data.net/v1/logs",
    };

    await main(params);

    expect(telemetryState.exporterOptions).toHaveLength(1);
    expect(telemetryState.exportedBatches).toHaveLength(1);
    expect(
      telemetryState.exportedBatches[0].some((record) =>
        String(record.body).includes("Tax quote received"),
      ),
    ).toBe(true);
  });
});
