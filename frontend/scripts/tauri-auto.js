#!/usr/bin/env node
/**
 * Auto-detect GPU and run Tauri with appropriate features
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Get the command (dev or build)
const command = process.argv[2];
if (!command || !['dev', 'build'].includes(command)) {
  console.error('Usage: node tauri-auto.js [dev|build]');
  process.exit(1);
}

// Detect GPU feature
let feature = '';

// Check for environment variable override first
if (process.env.TAURI_GPU_FEATURE) {
  feature = process.env.TAURI_GPU_FEATURE;
  console.log(`🔧 Using forced GPU feature from environment: ${feature}`);
} else {
  try {
    const result = execSync('node scripts/auto-detect-gpu.js', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'inherit']
    });
    feature = result.trim();
  } catch (err) {
    // If detection fails, continue with no features
  }
}

console.log(''); // Empty line for spacing

// Platform-specific environment variables
const platform = os.platform();
const env = { ...process.env };

// Ensure local node_modules/.bin is in PATH so tauri binary is always found
const binDir = path.resolve(__dirname, '../node_modules/.bin');
const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH';
env[pathKey] = `${binDir}${path.delimiter}${process.env[pathKey] || ''}`;

if (platform === 'linux' && feature === 'cuda') {
  console.log('🐧 Linux/CUDA detected: Setting CMAKE flags for NVIDIA GPU');
  env.CMAKE_CUDA_ARCHITECTURES = '75';
  env.CMAKE_CUDA_STANDARD = '17';
  env.CMAKE_POSITION_INDEPENDENT_CODE = 'ON';
}

if (platform === 'win32' && feature === 'cuda') {
  console.log('🪟 Windows/CUDA detected: Setting CMAKE and CCCL flags for NVIDIA GPU');
  env.CMAKE_CUDA_ARCHITECTURES = '75;80;86;89;120';
  env.CMAKE_CUDA_STANDARD = '17';
  const ccclFlags = '-DCCCL_IGNORE_MSVC_TRADITIONAL_PREPROCESSOR_WARNING -DCCCL_IGNORE_DEPRECATED_CPP_DIALECT';
  const zcFlag = '/Zc:preprocessor';
  env.CMAKE_CUDA_FLAGS = (env.CMAKE_CUDA_FLAGS ? env.CMAKE_CUDA_FLAGS + ' ' : '') + `--std=c++17 ${ccclFlags} -Xcompiler="${zcFlag}"`;
  env.CL = (env.CL ? env.CL + ' ' : '') + `${ccclFlags} ${zcFlag}`;
  env._CL_ = (env._CL_ ? env._CL_ + ' ' : '') + `${ccclFlags} ${zcFlag}`;
}

// Build the tauri command
let tauriCmd = `tauri ${command}`;
const extraArgs = process.argv.slice(3).join(' ');
if (feature && feature !== 'none') {
  tauriCmd += ` -- --features ${feature}`;
  if (extraArgs) tauriCmd += ` ${extraArgs}`;
  console.log(`🚀 Running: ${tauriCmd}`);
} else {
  if (extraArgs) tauriCmd += ` ${extraArgs}`;
  console.log(`🚀 Running: ${tauriCmd} (CPU-only mode)`);
}
console.log('');

// Execute the command
try {
  execSync(tauriCmd, { stdio: 'inherit', env });
} catch (err) {
  process.exit(err.status || 1);
}
