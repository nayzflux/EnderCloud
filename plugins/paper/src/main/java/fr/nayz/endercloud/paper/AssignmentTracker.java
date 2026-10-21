package fr.nayz.endercloud.paper;

import fr.nayz.endercloud.core.model.SessionAssignment;
import java.util.Optional;
import java.util.Objects;

/** Orders async responses and keeps acknowledgements scoped to their session. */
final class AssignmentTracker {
    private long appliedRequest;
    private SessionAssignment assignment;
    private String acknowledgedSession;
    private int acknowledgedRevision;

    synchronized SessionAssignment get() { return assignment; }

    synchronized boolean accept(long request, Optional<SessionAssignment> response) {
        if (request <= appliedRequest) return false;
        appliedRequest = request;
        SessionAssignment next = response.orElse(null);
        if (assignment != null && next != null && assignment.sessionId().equals(next.sessionId())
                && next.revision() < assignment.revision()) return false;
        if (next == null || assignment == null || !next.sessionId().equals(assignment.sessionId())) {
            acknowledgedSession = null;
            acknowledgedRevision = 0;
        }
        assignment = next;
        return true;
    }

    synchronized boolean isAcknowledged(SessionAssignment value) {
        return Objects.equals(acknowledgedSession, value.sessionId()) && acknowledgedRevision >= value.revision();
    }

    synchronized void acknowledge(SessionAssignment value) {
        if (assignment == null || !assignment.sessionId().equals(value.sessionId())) return;
        acknowledgedSession = value.sessionId();
        acknowledgedRevision = Math.max(acknowledgedRevision, value.revision());
    }
}
