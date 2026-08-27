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

if (platform === 'linux' && feature === 'hipblas') {
  // llama-cpp-sys requires ROCM_PATH/HIP_PATH to point to a directory
  // containing lib/. Fedora commonly installs ROCm under /usr/lib64/rocm.
  if (!env.ROCM_PATH && !env.HIP_PATH) {
    const candidates = ['/opt/rocm', '/usr/local/rocm', '/usr/lib64/rocm', '/usr/lib/rocm'];
    const rocmPath = candidates.find((candidate) =>
      fs.existsSync(path.join(candidate, 'lib'))
    );
    if (rocmPath) {
      env.ROCM_PATH = rocmPath;
    }
  }

  if (env.ROCM_PATH) {
    console.log(`🔴 AMD ROCm SDK: ${env.ROCM_PATH}`);
  } else if (env.HIP_PATH) {
    console.log(`🔴 AMD HIP SDK: ${env.HIP_PATH}`);
  } else {
    console.error('❌ ROCm SDK not found; set ROCM_PATH or HIP_PATH');
    process.exit(1);
  }

  if (!env.CMAKE_HIP_COMPILER_ROCM_ROOT) {
    const sdkPath = env.ROCM_PATH || env.HIP_PATH;
    const standardRoot = path.join(sdkPath, 'lib', 'cmake', 'hip-lang');
    const distroRoot = path.resolve(sdkPath, '..', '..');
    if (fs.existsSync(path.join(standardRoot, 'hip-lang-config.cmake'))) {
      env.CMAKE_HIP_COMPILER_ROCM_ROOT = sdkPath;
    } else if (
      fs.existsSync(path.join(distroRoot, 'lib64', 'cmake', 'hip-lang', 'hip-lang-config.cmake'))
    ) {
      env.CMAKE_HIP_COMPILER_ROCM_ROOT = distroRoot;
    }
  }

  if (env.CMAKE_HIP_COMPILER_ROCM_ROOT) {
    console.log(`🔴 HIP CMake root: ${env.CMAKE_HIP_COMPILER_ROCM_ROOT}`);
  }
}
if (platform === 'linux' && feature === 'cuda') {
  console.log('🐧 Linux/CUDA detected: Setting CMAKE flags for NVIDIA GPU');
  env.CMAKE_CUDA_ARCHITECTURES = '75';
  env.CMAKE_CUDA_STANDARD = '17';
  env.CMAKE_POSITION_INDEPENDENT_CODE = 'ON';
}
// Build the tauri command
let tauriCmd = `tauri ${command}`;
if (feature && feature !== 'none') {
  tauriCmd += ` -- --features ${feature}`;
  console.log(`🚀 Running: tauri ${command} with features: ${feature}`);
} else {
  console.log(`🚀 Running: tauri ${command} (CPU-only mode)`);
}
console.log('');

// Execute the command
try {
  execSync(tauriCmd, { stdio: 'inherit', env });
} catch (err) {
  process.exit(err.status || 1);
}
