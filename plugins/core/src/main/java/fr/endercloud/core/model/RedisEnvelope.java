package fr.endercloud.core.model;

import com.fasterxml.jackson.databind.JsonNode;

public record RedisEnvelope(
        int schemaVersion,
        String eventId,
        String type,
        String occurredAt,
        JsonNode payload
) {
}
