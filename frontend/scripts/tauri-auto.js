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

if (platform === 'win32') {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const nsisDir = path.join(localAppData, 'tauri', 'NSIS');
  if (fs.existsSync(nsisDir)) {
    env[pathKey] = `${nsisDir}${path.delimiter}${env[pathKey]}`;
  }
  if (!env.LIBCLANG_PATH && fs.existsSync('C:\\Program Files\\LLVM\\bin')) {
    env.LIBCLANG_PATH = 'C:\\Program Files\\LLVM\\bin';
  }
  if (!env.BINDGEN_EXTRA_CLANG_ARGS && fs.existsSync('C:\\Program Files\\LLVM\\lib\\clang\\18\\include')) {
    env.BINDGEN_EXTRA_CLANG_ARGS = '-I"C:/Program Files/LLVM/lib/clang/18/include"';
  }
}

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

if (platform === 'win32' && feature === 'cuda') {
  console.log('🪟 Windows/CUDA detected: Setting CMAKE and CCCL flags for NVIDIA GPU');
  env.CMAKE_CUDA_ARCHITECTURES ||= '75;80;86;89;90;100;120';
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
