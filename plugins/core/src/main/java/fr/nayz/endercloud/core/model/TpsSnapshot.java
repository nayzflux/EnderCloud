package fr.nayz.endercloud.core.model;

public record TpsSnapshot(
        double oneMinute,
        double fiveMinutes,
        double fifteenMinutes
) {
    public TpsSnapshot {
        validate(oneMinute, "oneMinute");
        validate(fiveMinutes, "fiveMinutes");
        validate(fifteenMinutes, "fifteenMinutes");
    }

    private static void validate(double value, String name) {
        if (!Double.isFinite(value) || value < 0 || value > 100) {
            throw new IllegalArgumentException(name + " must be between 0 and 100");
        }
    }
}
