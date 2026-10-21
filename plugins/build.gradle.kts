plugins {
    base
    alias(libs.plugins.shadow) apply false
}

allprojects {
    group = "fr.nayz.endercloud"
    version = "0.1.0"

    dependencyLocking {
        lockAllConfigurations()
        // Gradle canonicalizes unique snapshots to a conflicting SNAPSHOT lock.
        // These two coordinates are pinned to immutable timestamps and verified by SHA-256.
        ignoredDependencies.add("com.velocitypowered:velocity-api")
        ignoredDependencies.add("com.velocitypowered:velocity-brigadier")
    }
}

subprojects {
    configurations.configureEach {
        resolutionStrategy.eachDependency {
            if (requested.group == "com.velocitypowered" && requested.name == "velocity-brigadier") {
                useVersion("1.0.0-20210613.082804-10")
                because("Release builds use immutable timestamped artifacts")
            }
        }
    }
    tasks.withType<JavaCompile>().configureEach {
        options.encoding = "UTF-8"
        options.release = 25
        options.compilerArgs.add("-parameters")
    }

    tasks.withType<Test>().configureEach {
        useJUnitPlatform()
        systemProperty(
            "endercloud.contracts.dir",
            rootProject.projectDir.parentFile.resolve("contracts").absolutePath
        )
    }
}
