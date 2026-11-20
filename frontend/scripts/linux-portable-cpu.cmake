# Both pinned inference sys crates forward CMAKE_* environment variables.
# whisper-rs-sys does not forward GGML_* variables, and its old WHISPER_NO_AVX*
# switches no longer configure ggml. Apply the baseline before project() so
# candidate binaries cannot inherit the build host's -march=native.
set(GGML_NATIVE OFF CACHE BOOL "Portable Linux candidate" FORCE)
foreach(feature AVX AVX2 AVX512 AVX512_VBMI AVX512_VNNI AVX512_BF16 AVX_VNNI FMA F16C)
  set(GGML_${feature} OFF CACHE BOOL "Portable Linux candidate" FORCE)
endforeach()
