package fr.nayz.endercloud.paper;

import fr.nayz.endercloud.core.model.SessionAssignment;
import fr.nayz.endercloud.core.model.SessionState;
import org.junit.jupiter.api.Test;
import java.util.List;
import java.util.Optional;
import static org.junit.jupiter.api.Assertions.*;

class AssignmentTrackerTest {
    private SessionAssignment value(String session, int revision) {
        return new SessionAssignment(session, "group", SessionState.WAITING, revision,
                0, 0, false, false, List.of(), null, List.of());
    }

    @Test void staleResponsesAndEmptyResponsesCannotReplaceNewerAssignments() {
        var tracker = new AssignmentTracker();
        var recent = value("session", 2);
        assertTrue(tracker.accept(2, Optional.of(recent)));
        assertFalse(tracker.accept(1, Optional.empty()));
        assertFalse(tracker.accept(3, Optional.of(value("session", 1))));
        assertEquals(recent, tracker.get());
    }

    @Test void acknowledgementCannotLeakIntoAnotherSession() {
        var tracker = new AssignmentTracker();
        var previous = value("old", 8);
        tracker.accept(1, Optional.of(previous));
        tracker.acknowledge(previous);
        var next = value("new", 1);
        tracker.accept(2, Optional.of(next));
        tracker.acknowledge(previous);
        assertFalse(tracker.isAcknowledged(next));
    }
}
