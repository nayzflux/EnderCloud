plugins {
    base
    alias(libs.plugins.shadow) apply false
}

allprojects {
    group = "fr.endercloud"
    version = "0.1.0"

    dependencyLocking {
        lockAllConfigurations()
    }
}

subprojects {
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
