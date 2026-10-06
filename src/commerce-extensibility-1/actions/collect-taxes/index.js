import {
  byCodeAndLevel,
  getConfigurationByKey,
  initialize,
} from "@adobe/aio-commerce-lib-config";
import {
  addOperation,
  exceptionOperation,
  isWebhookSuccessful,
  ok,
  replaceOperation,
} from "@adobe/aio-commerce-sdk/webhooks/responses";
import {
  getInstrumentationHelpers,
  instrumentEntrypoint,
} from "@adobe/aio-lib-telemetry";

import appConfig from "#app.commerce.config";

import { checkoutMetrics } from "../checkout-metrics.js";
import { telemetryConfig } from "../telemetry.js";

const TAX_SERVICE_ERRORS = {
  400: {
    INVALID_ADDRESS: "The tax address is invalid or unsupported.",
    INVALID_REQUEST: "A required field or item value is invalid.",
  },
  401: {
    UNAUTHORIZED: "Basic credentials are missing or invalid.",
  },
  500: {
    INTERNAL_ERROR: "An unexpected server error occurred.",
    TAX_CALCULATION_FAILED: "The tax calculation failed.",
  },
};

/**
 * This action calculates the tax for the given request.
 * It runs with require-adobe-auth: true; webhook signature verification is
 * handled by the App Management platform's declarative webhooks[] subscription,
 * not by this action.
 *
 * @param {object} params the input parameters, including the parsed `oopQuote` payload
 * @returns {{statusCode: number, body: object}} the response object
 * @see https://developer.adobe.com/commerce/extensibility/webhooks
 */
async function collectTaxes(params) {
  const { logger, currentSpan } = getInstrumentationHelpers();
  let stage = "receive quote";

  logger.debug("Starting tax collection process");

  try {
    const { oopQuote } = params;
    logger.info(
      "Tax quote received : ",
      JSON.stringify(oopQuote, null, 2),
    );
    currentSpan.setAttribute("quote.items.count", oopQuote?.items?.length || 0);

    stage = "load configuration";
    logger.info("Loading tax service configuration");
    const { baseUrl, endpoint, apiKey } = await getTaxServiceConfig(params);
    logger.info("Tax service configuration loaded");

    stage = "prepare request";
    const request = createTaxRequest(oopQuote);
    const url = new URL(endpoint, baseUrl);
    if (url.origin !== new URL(baseUrl).origin) {
      throw new Error("Tax API endpoint must use the configured base URL");
    }
    logger.info("Tax request prepared", {
      discountAmount: request.discount_amount,
      itemCount: request.items.length,
      shippingAmount: request.shipping_amount,
    });

    stage = "call tax service";
    logger.info("Calling tax service", { path: url.pathname });
    logger.debug("Tax request payload", JSON.stringify(request, null, 2));
    const response = await fetch(url, {
      body: JSON.stringify(request),
      headers: {
        Authorization: `Basic ${apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(8000),
    });
    logger.info("Tax service responded", { status: response.status });
    if (!response.ok) {
      throw await getTaxServiceError(response);
    }

    stage = "parse tax response";
    const result = await response.json();
    logger.info("Tax response parsed", {
      itemCount: result?.items?.length ?? 0,
    });

    stage = "create Commerce operations";
    const operations = createTaxOperations(oopQuote, result);
    logger.info("Commerce tax operations created", {
      count: operations.length,
    });

    logger.info(
      "Tax calculation response : ",
      JSON.stringify(operations, null, 2),
    );

    checkoutMetrics.collectTaxesCounter.add(1, { status: "success" });

    return ok(operations);
  } catch (error) {
    logger.error(`Tax collection failed during ${stage}:`, error);
    checkoutMetrics.collectTaxesCounter.add(1, {
      errorCode: error.code ?? "exception",
      status: "error",
    });
    return ok(exceptionOperation(`Server error: ${error.message}`));
  }
}

async function getTaxServiceError(response) {
  let errorBody;
  try {
    errorBody = await response.json();
  } catch {
    return new Error(`Tax service returned HTTP ${response.status}`);
  }

  const code =
    errorBody?.code ??
    errorBody?.error?.code ??
    errorBody?.error_code ??
    (typeof errorBody?.error === "string" ? errorBody.error : undefined);
  const descriptions = TAX_SERVICE_ERRORS[response.status];
  if (!(descriptions && Object.hasOwn(descriptions, code))) {
    return new Error(`Tax service returned HTTP ${response.status}`);
  }

  const error = new Error(
    `Tax service HTTP ${response.status} ${code}: ${descriptions[code]}`,
  );
  error.code = code;
  return error;
}

async function getTaxServiceConfig(params) {
  await initialize({ params, schema: appConfig.businessConfig.schema });
  const scope = byCodeAndLevel("global", "global");
  const [baseUrl, endpoint, apiKey] = await Promise.all([
    getConfigurationByKey("mock-data-base-url", scope),
    getConfigurationByKey("mock-data-api-endpoint", scope),
    getConfigurationByKey("mock-data-api-key", scope, {
      encryptionKey: params.AIO_COMMERCE_CONFIG_ENCRYPTION_KEY,
    }),
  ]);
  if (
    !(baseUrl.config?.value && endpoint.config?.value && apiKey.config?.value)
  ) {
    throw new Error(
      "Tax service base URL, API endpoint and API key must be configured",
    );
  }
  return {
    apiKey: apiKey.config.value,
    baseUrl: baseUrl.config.value,
    endpoint: endpoint.config.value,
  };
}

function createTaxRequest(quote) {
  if (!(Array.isArray(quote?.items) && quote.ship_to_address)) {
    throw new Error("Missing quote items or shipping address");
  }
  const products = quote.items.filter((item) => item.type !== "shipping");
  return {
    currency: "USD",
    discount_amount: products.reduce(
      (amount, item) => amount + Number(item.discount_amount || 0),
      0,
    ),
    items: products.map((item) => ({
      quantity: Number(item.quantity),
      sku: item.sku,
      tax_class: item.custom_attributes?.tax_code ?? item.tax_class,
      unit_price: Number(item.unit_price),
    })),
    shipping_address: {
      city: quote.ship_to_address.city,
      country_code: quote.ship_to_address.country,
      postal_code: quote.ship_to_address.postcode,
      region: quote.ship_to_address.region_code,
    },
    shipping_amount: quote.items
      .filter((item) => item.type === "shipping")
      .reduce(
        (amount, item) =>
          amount + Number(item.unit_price) * Number(item.quantity),
        0,
      ),
  };
}

function createTaxOperations(quote, result) {
  if (result?.success !== true || !Array.isArray(result.items)) {
    throw new Error("Tax service returned an invalid result");
  }
  const remaining = [...result.items];
  const operations = quote.items.flatMap((item, index) => {
    if (item.type === "shipping") {
      return createShippingTaxOperations(
        item,
        index,
        result.shipping_tax_amount,
      );
    }
    const matchIndex = remaining.findIndex((entry) => entry.sku === item.sku);
    if (matchIndex < 0) {
      throw new Error(`Tax service did not return tax for SKU ${item.sku}`);
    }
    const [tax] = remaining.splice(matchIndex, 1);
    return createProductTaxOperations(item, index, tax);
  });
  if (remaining.length > 0) {
    throw new Error("Tax service returned unexpected items");
  }
  return operations;
}

function isFiniteAmount(value) {
  return (
    value !== null &&
    value !== undefined &&
    value !== "" &&
    Number.isFinite(Number(value))
  );
}

function createShippingTaxOperations(item, index, shippingTaxAmount) {
  const amount = Number(shippingTaxAmount);
  if (!isFiniteAmount(shippingTaxAmount)) {
    throw new Error("Tax service did not return shipping tax");
  }
  const base = Number(item.unit_price) * Number(item.quantity);
  const rate = base > 0 ? Math.round((amount / base) * 10_000) / 100 : 0;
  return [
    createTaxBreakdownOperation(
      index,
      { code: "shipping_tax", rate, title: "Shipping Tax" },
      amount,
    ),
    createTaxSummaryOperation(index, rate, amount, 0),
  ];
}

function createProductTaxOperations(item, index, tax) {
  const amount = Number(tax.tax_amount);
  const taxableAmount = Number(tax.taxable_amount);
  if (
    !(
      isFiniteAmount(tax.tax_amount) &&
      isFiniteAmount(tax.taxable_amount) &&
      Array.isArray(tax.tax_details)
    )
  ) {
    throw new Error(`Tax service returned invalid tax for SKU ${item.sku}`);
  }
  const breakdown = tax.tax_details.map((detail) => {
    if (
      !(
        isFiniteAmount(detail.amount) &&
        isFiniteAmount(detail.rate) &&
        detail.code &&
        detail.title
      )
    ) {
      throw new Error(
        `Tax service returned invalid breakdown for SKU ${item.sku}`,
      );
    }
    return createTaxBreakdownOperation(index, detail, Number(detail.amount));
  });
  const rate =
    taxableAmount > 0 ? Math.round((amount / taxableAmount) * 10_000) / 100 : 0;
  const discount = Number(item.discount_amount || 0);
  const compensation =
    item.is_tax_included && rate > 0
      ? Math.round((discount - discount / (1 + rate / 100)) * 100) / 100
      : 0;
  return [
    ...breakdown,
    createTaxSummaryOperation(index, rate, amount, compensation),
  ];
}

/**
 * Creates a tax breakdown operation for the given item.
 * @param {number} index operation index
 * @param {object} tax operation tax
 * @param {number} taxAmount operation tax amount
 * @returns {object} the response operation
 * @see https://developer.adobe.com/commerce/extensibility/webhooks/responses/#add-operation
 */
function createTaxBreakdownOperation(index, tax, taxAmount) {
  return addOperation(
    `oopQuote/items/${index}/tax_breakdown`,
    {
      data: {
        amount: taxAmount,
        code: tax.code,
        rate: tax.rate,
        tax_rate_key: `${tax.code}-${tax.rate}`,
        title: tax.title,
      },
    },
    "Magento\\OutOfProcessTaxManagement\\Api\\Data\\OopQuoteItemTaxBreakdownInterface",
  );
}

/**
 * Creates a tax summary operation for the given item.
 * @param {number} index operation index
 * @param {number} itemTaxRate operation item tax rate
 * @param {number} itemTaxAmount operation item tax amount
 * @param {number} discountCompensationTaxAmount operation discount compensation tax amount
 * @returns {object} the response operation
 * @see https://developer.adobe.com/commerce/extensibility/webhooks/responses/#replace-operation
 */
function createTaxSummaryOperation(
  index,
  itemTaxRate,
  itemTaxAmount,
  discountCompensationTaxAmount,
) {
  return replaceOperation(
    `oopQuote/items/${index}/tax`,
    {
      data: {
        amount: itemTaxAmount,
        discount_compensation_amount: discountCompensationTaxAmount,
        rate: itemTaxRate,
      },
    },
    "Magento\\OutOfProcessTaxManagement\\Api\\Data\\OopQuoteItemTaxInterface",
  );
}

// Export the instrumented function as main
export const main = instrumentEntrypoint(collectTaxes, {
  ...telemetryConfig,
  isSuccessful: isWebhookSuccessful,
});
