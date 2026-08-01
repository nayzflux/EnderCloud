plugins {
    java
    `maven-publish`
    alias(libs.plugins.shadow)
}

java {
    toolchain.languageVersion = JavaLanguageVersion.of(25)
}

dependencies {
    implementation(project(":core"))
    compileOnly(libs.paper.api)

    testImplementation(platform(libs.junit.bom))
    testImplementation(libs.junit.jupiter)
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks {
    register("copyJarToServer1", Copy::class) {
        from(shadowJar.get().archiveFile)
        into("${System.getenv("USERPROFILE")}/Documents/Code/Minecraft/EnderCloud/templates/hub/plugins")
    }

    register("copyJarToServer2", Copy::class) {
        from(shadowJar.get().archiveFile)
        into("${System.getenv("USERPROFILE")}/Documents/Code/Minecraft/EnderCloud/templates/skywars-solo-japan/plugins")
    }

    register("copyJarToServer3", Copy::class) {
        from(shadowJar.get().archiveFile)
        into("${System.getenv("USERPROFILE")}/Documents/Code/Minecraft/EnderCloud/templates/skywars-solo-dome/plugins")
    }

    register("copyJarToServer4", Copy::class) {
        from(shadowJar.get().archiveFile)
        into("${System.getenv("USERPROFILE")}/Documents/Code/Minecraft/EnderCloud/templates/skywars-duo-dome/plugins")
    }
}

tasks.processResources {
    inputs.property("version", project.version)
    filesMatching("plugin.yml") {
        expand("version" to project.version)
    }
}

tasks.shadowJar {
    archiveBaseName.set("EnderCloudPaper")
    archiveClassifier = ""
    relocate("com.fasterxml.jackson", "fr.endercloud.libs.jackson")
}

publishing {
    publications {
        create<MavenPublication>("mavenJava") {
            from(components["shadow"])
            groupId = "fr.nayz.endercloud"
            artifactId = "paper"
        }
    }
}

tasks.build {
    dependsOn(tasks.publishToMavenLocal)
    finalizedBy("copyJarToServer1", "copyJarToServer2", "copyJarToServer3", "copyJarToServer4")
}
