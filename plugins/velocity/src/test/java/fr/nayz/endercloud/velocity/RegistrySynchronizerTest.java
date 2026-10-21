package fr.nayz.endercloud.velocity;

import org.junit.jupiter.api.Test;
import java.util.ArrayList;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

class RegistrySynchronizerTest {
    @Test void eventsReceivedDuringSnapshotAreReplayedAfterIt() {
        var order = new ArrayList<String>();
        var registry = new RegistrySynchronizer<String>();
        registry.begin();
        assertFalse(registry.event(1, "recent", order::add));
        assertTrue(registry.snapshot(0, () -> order.add("old snapshot"), order::add));
        assertEquals(List.of("old snapshot", "recent"), order);
        assertTrue(registry.event(1, "duplicate", order::add));
        assertEquals(2, order.size());
    }

    @Test void anOlderSnapshotCannotUndoARecentOneAndGapsRequireResynchronization() {
        var order = new ArrayList<String>();
        var registry = new RegistrySynchronizer<String>();
        registry.snapshot(2, () -> order.add("snapshot 2"), order::add);
        registry.snapshot(1, () -> order.add("obsolete"), order::add);
        assertFalse(registry.event(4, "event 4", order::add));
        assertTrue(registry.snapshot(3, () -> order.add("snapshot 3"), order::add));
        assertEquals(List.of("snapshot 2", "snapshot 3", "event 4"), order);
    }
}
