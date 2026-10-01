import { getCommerceClient } from "@adobe/aio-commerce-lib-app";
import { forwardImsAuthProvider } from "@adobe/aio-commerce-sdk/auth";
import { ok } from "@adobe/aio-commerce-sdk/core/responses";

const SUPPORTED_METHODS = new Set(["GET", "POST", "DELETE"]);

// Commerce webapi errors return placeholders (%1 or %name) plus a separate `parameters` list/map.
function formatCommerceMessage({ message, parameters }) {
  if (!(message && parameters)) {
    return message;
  }
  const values = Array.isArray(parameters) ? parameters : Object.values(parameters);
  return message.replace(/%(\w+)/g, (match, key) => {
    if (/^\d+$/.test(key)) {
      return values[Number(key) - 1] ?? match;
    }
    return Array.isArray(parameters) ? match : (parameters[key] ?? match);
  });
}

/**
 * Generic Commerce REST proxy for this extension's Admin UI, forwarding the caller's own IMS
 * bearer token — never this app's own association credentials — to a Commerce client resolved
 * from this app's stored association. No COMMERCE_BASE_URL input is needed: the instance URL
 * comes from the association, not from action config. Callers pass an arbitrary `operation`
 * (a Commerce REST path fragment), so any resource can be routed through this one action.
 * @param {object} params action input parameters.
 * @returns {Promise<object>} returns a response object
 */
export async function main(params) {
  const { operation, method = "GET", payload = null } = params;
  const httpMethod = method.toUpperCase();

  if (!SUPPORTED_METHODS.has(httpMethod)) {
    return {
      body: { message: `Method ${httpMethod} not allowed` },
      statusCode: 405,
    };
  }

  let authProvider;
  try {
    authProvider = forwardImsAuthProvider(params);
  } catch (error) {
    return { body: { message: error.message }, statusCode: 400 };
  }

  try {
    const client = await getCommerceClient(authProvider);
    const response =
      httpMethod === "GET"
        ? await client.get(operation).json()
        : httpMethod === "DELETE"
          ? await client.delete(operation).json()
          : await client.post(operation, { json: payload }).json();

    return ok({ body: response });
  } catch (error) {
    // ky's HTTPError exposes the raw Response; Commerce's webapi error body (e.g. validation
    // messages) lives there, not in error.message, which is just the generic status line.
    const commerceMessage = await error.response
      ?.json()
      .then((body) => (body ? formatCommerceMessage(body) : null))
      .catch(() => null);

    return {
      body: {
        message: commerceMessage
          ? `Commerce request failed: ${commerceMessage}`
          : `Commerce request failed: ${error.message}`,
      },
      statusCode: error.response?.status ?? 500,
    };
  }
}
