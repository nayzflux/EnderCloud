package fr.nayz.endercloud.velocity;

import java.util.TreeMap;
import java.util.function.Consumer;

/** Serializes snapshot application with events and detects missing registry revisions. */
final class RegistrySynchronizer<E> {
    private long revision = -1;
    private boolean loading;
    private final TreeMap<Long, E> pending = new TreeMap<>();

    synchronized void begin() { loading = true; }
    synchronized void failed() { loading = false; }

    synchronized boolean event(long version, E event, Consumer<E> apply) {
        if (version <= revision) return true;
        pending.put(version, event);
        if (!loading) drain(apply);
        return pending.isEmpty();
    }

    synchronized boolean snapshot(long version, Runnable applySnapshot, Consumer<E> applyEvent) {
        if (version >= revision) {
            applySnapshot.run();
            revision = version;
        }
        pending.headMap(revision, true).clear();
        loading = false;
        drain(applyEvent);
        return pending.isEmpty();
    }

    private void drain(Consumer<E> apply) {
        if (revision < 0) return;
        while (pending.containsKey(revision + 1)) {
            E event = pending.get(revision + 1);
            apply.accept(event);
            pending.remove(++revision);
        }
    }
}
