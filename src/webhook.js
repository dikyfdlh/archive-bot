export function parseWhatsAppWebhook(payload) {
  const events = {
    messages: [],
    statuses: [],
    errors: [],
    metadata: []
  };

  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const contactsByWaId = new Map(
        (value.contacts || []).map((contact) => [contact.wa_id, contact.profile?.name || ""])
      );

      if (value.metadata) {
        events.metadata.push(value.metadata);
      }

      for (const message of value.messages || []) {
        events.messages.push({
          message,
          contactName: contactsByWaId.get(message.from) || "",
          phoneNumberId: value.metadata?.phone_number_id || "",
          displayPhoneNumber: value.metadata?.display_phone_number || ""
        });
      }

      for (const status of value.statuses || []) {
        events.statuses.push({
          status,
          phoneNumberId: value.metadata?.phone_number_id || "",
          displayPhoneNumber: value.metadata?.display_phone_number || ""
        });
      }

      for (const error of value.errors || []) {
        events.errors.push(error);
      }
    }
  }

  return events;
}

export function summarizeWebhookEvents(events) {
  return {
    messages: events.messages.length,
    statuses: events.statuses.length,
    errors: events.errors.length,
    metadata: events.metadata.length,
    messageTypes: countBy(events.messages, (event) => event.message.type || "unknown"),
    statusTypes: countBy(events.statuses, (event) => event.status.status || "unknown")
  };
}

export function parseJsonBody(rawBody) {
  if (!rawBody.length) {
    return {};
  }

  try {
    return JSON.parse(rawBody.toString("utf8"));
  } catch (error) {
    error.statusCode = 400;
    error.publicMessage = "Invalid JSON body";
    throw error;
  }
}

function countBy(items, keyFn) {
  const result = {};

  for (const item of items) {
    const key = keyFn(item);
    result[key] = (result[key] || 0) + 1;
  }

  return result;
}
