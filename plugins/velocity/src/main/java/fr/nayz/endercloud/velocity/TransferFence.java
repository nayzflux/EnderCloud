package fr.nayz.endercloud.velocity;

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

final class TransferFence {
    enum Decision { ACCEPT, EXPIRED, SUPERSEDED, SOURCE_CHANGED }
    private record Lease(long generation, Instant expiresAt) {}
    private final Map<UUID, Lease> latest = new HashMap<>();

    synchronized void observe(UUID player, long generation, Instant expiresAt, Instant now) {
        latest.entrySet().removeIf(entry -> !entry.getValue().expiresAt().isAfter(now));
        Lease previous = latest.get(player);
        if (previous == null || generation > previous.generation()) latest.put(player, new Lease(generation, expiresAt));
    }

    synchronized Decision check(UUID player, long generation, Instant expiresAt, String source, String actualSource, Instant now) {
        if (!expiresAt.isAfter(now)) return Decision.EXPIRED;
        Lease lease = latest.get(player);
        if (lease == null || generation != lease.generation()) return Decision.SUPERSEDED;
        if (source != null && !Objects.equals(source, actualSource)) return Decision.SOURCE_CHANGED;
        return Decision.ACCEPT;
    }
}
