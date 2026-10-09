import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@adobe/aio-commerce-lib-config", () => ({
  byCodeAndLevel: vi.fn((code, level) => ({ code, level })),
  getConfigurationByKey: vi.fn(),
  initialize: vi.fn(),
}));

const { getConfigurationByKey } = await import(
  "@adobe/aio-commerce-lib-config"
);
const { main } = await import(
  "../../src/commerce-extensibility-1/actions/collect-adjustment-taxes/index.js"
);

function buildParams(oopCreditMemo) {
  return {
    ENABLE_TELEMETRY: true,
    oopCreditMemo,
  };
}

describe("collect-adjustment-taxes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConfigurationByKey.mockResolvedValue({ config: { value: true } });
  });

  test("skips adjustment taxes when the app is disabled", async () => {
    getConfigurationByKey.mockResolvedValue({ config: { value: false } });

    const result = await main(buildParams(undefined));

    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({ op: "success" });
    expect(getConfigurationByKey).toHaveBeenCalledWith("app-enabled", {
      code: "global",
      level: "global",
    });
  });

  test("keeps adjustment taxes enabled when the setting is not saved yet", async () => {
    getConfigurationByKey.mockResolvedValue({});

    const result = await main(
      buildParams({
        adjustment: { refund: 100 },
        items: [{ is_tax_included: false }],
      }),
    );

    expect(result.body).toContainEqual(
      expect.objectContaining({
        op: "replace",
        path: "oopCreditMemo/adjustment/refund_tax",
        value: 8.1,
      }),
    );
  });

  test("calculates refund and fee tax at the excluding-tax rate", async () => {
    const result = await main(
      buildParams({
        adjustment: { fee: 10, refund: 100 },
        items: [{ is_tax_included: false }],
      }),
    );

    expect(result.statusCode).toBe(200);
    expect(result.body).toContainEqual(
      expect.objectContaining({
        op: "replace",
        path: "oopCreditMemo/adjustment/refund_tax",
        value: 8.1,
      }),
    );
    expect(result.body).toContainEqual(
      expect.objectContaining({
        op: "replace",
        path: "oopCreditMemo/adjustment/fee_tax",
        value: 0.81,
      }),
    );
  });

  test("uses the including-tax rate when any item has tax included", async () => {
    const result = await main(
      buildParams({
        adjustment: { refund: 100 },
        items: [{ is_tax_included: true }],
      }),
    );

    expect(result.body).toContainEqual(
      expect.objectContaining({
        op: "replace",
        path: "oopCreditMemo/adjustment/refund_tax",
        value: 8.4,
      }),
    );
  });

  test("skips refund/fee tax operations that aren't present", async () => {
    const result = await main(
      buildParams({ adjustment: {}, items: [{ is_tax_included: false }] }),
    );

    expect(result.body).toEqual([]);
  });

  test("returns an exception operation for invalid oopCreditMemo data", async () => {
    const result = await main(buildParams({ items: undefined }));

    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual(
      expect.objectContaining({
        message: "Invalid or missing oopCreditMemo data",
        op: "exception",
      }),
    );
  });
});
