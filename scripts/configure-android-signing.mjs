#!/usr/bin/env node
/**
 * Configure the generated Tauri Android Gradle project for release signing.
 *
 * The keystore and passwords are supplied only through CI environment
 * variables. Nothing secret is written outside the runner temp directory or
 * committed to the repository. The generated Gradle project is disposable.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const androidRoot = path.join(repoRoot, 'apps', 'tauri', 'src-tauri', 'gen', 'android')
const gradlePath = path.join(androidRoot, 'app', 'build.gradle.kts')
const propertiesPath = path.join(androidRoot, 'keystore.properties')
const runnerTemp = process.env.RUNNER_TEMP || os.tmpdir()
const keystorePath = path.join(runnerTemp, 'harnessdock-android-upload.jks')

const required = (name) => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} GitHub secret is required for Android release signing`)
  return value
}

const keyBase64 = required('ANDROID_KEY_BASE64')
const keyAlias = required('ANDROID_KEY_ALIAS')
const keyPassword = required('ANDROID_KEY_PASSWORD')

if (!existsSync(gradlePath)) {
  throw new Error(`generated Android Gradle file is missing: ${gradlePath}; run tauri android init first`)
}

const normalizedBase64 = keyBase64.replace(/\s+/g, '')
if (
  normalizedBase64.length % 4 !== 0
  || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalizedBase64)
) {
  throw new Error('ANDROID_KEY_BASE64 is not valid canonical base64')
}
const keystore = Buffer.from(normalizedBase64, 'base64')
const roundTrip = keystore.toString('base64').replace(/=+$/, '')
if (roundTrip !== normalizedBase64.replace(/=+$/, '') || keystore.length < 128) {
  throw new Error('ANDROID_KEY_BASE64 did not decode to a valid-sized canonical keystore payload')
}
writeFileSync(keystorePath, keystore, { mode: 0o600 })
try { chmodSync(keystorePath, 0o600) } catch {}

const escapeProperty = (value) => value.replace(/\\/g, '\\\\').replace(/\n|\r/g, '')
writeFileSync(propertiesPath, [
  `password=${escapeProperty(keyPassword)}`,
  `keyAlias=${escapeProperty(keyAlias)}`,
  `storeFile=${escapeProperty(keystorePath)}`,
  '',
].join('\n'), { mode: 0o600 })
try { chmodSync(propertiesPath, 0o600) } catch {}

let gradle = readFileSync(gradlePath, 'utf8')
if (!gradle.includes('import java.util.Properties')) gradle = `import java.util.Properties\n${gradle}`
if (!gradle.includes('import java.io.FileInputStream')) gradle = `import java.io.FileInputStream\n${gradle}`

const signingBlock = `
    signingConfigs {
        create("release") {
            val keystorePropertiesFile = rootProject.file("keystore.properties")
            val keystoreProperties = Properties()
            if (!keystorePropertiesFile.exists()) {
                throw GradleException("keystore.properties is required for HarnessDock release signing")
            }
            keystoreProperties.load(FileInputStream(keystorePropertiesFile))
            keyAlias = keystoreProperties["keyAlias"] as String
            keyPassword = keystoreProperties["password"] as String
            storeFile = file(keystoreProperties["storeFile"] as String)
            storePassword = keystoreProperties["password"] as String
        }
    }
`

if (!gradle.includes('signingConfigs {')) {
  const marker = /\n\s*buildTypes\s*\{/
  const match = gradle.match(marker)
  if (!match || match.index == null) throw new Error('unable to locate Android buildTypes block for signing configuration')
  gradle = `${gradle.slice(0, match.index)}\n${signingBlock}${gradle.slice(match.index)}`
}

if (!gradle.includes('signingConfig = signingConfigs.getByName("release")')) {
  const releaseMarker = /getByName\("release"\)\s*\{/
  const match = gradle.match(releaseMarker)
  if (!match || match.index == null) throw new Error('unable to locate Android release build type for signing configuration')
  const insertAt = match.index + match[0].length
  gradle = `${gradle.slice(0, insertAt)}\n            signingConfig = signingConfigs.getByName("release")${gradle.slice(insertAt)}`
}

writeFileSync(gradlePath, gradle)
console.log('Android release signing configured from CI secrets; keystore remains runner-private.')
