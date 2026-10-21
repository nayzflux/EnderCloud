package fr.nayz.endercloud.velocity;

import org.junit.jupiter.api.Test;
import java.time.Instant;
import java.util.UUID;
import static org.junit.jupiter.api.Assertions.*;

class TransferFenceTest {
    @Test void aPlayerWhoMovedFromAToCIsNotMovedByAnOldAToBCommand() {
        var fence = new TransferFence();
        var player = UUID.randomUUID();
        var now = Instant.now();
        var expiry = now.plusSeconds(20);
        fence.observe(player, 1, expiry, now);
        assertEquals(TransferFence.Decision.SOURCE_CHANGED, fence.check(player, 1, expiry, "A", "C", now));
        assertEquals(TransferFence.Decision.ACCEPT, fence.check(player, 1, expiry, "A", "A", now));
        fence.observe(player, 2, expiry, now);
        assertEquals(TransferFence.Decision.SUPERSEDED, fence.check(player, 1, expiry, "A", "A", now));
        assertEquals(TransferFence.Decision.EXPIRED, fence.check(player, 2, expiry, "A", "A", expiry));
    }
}
