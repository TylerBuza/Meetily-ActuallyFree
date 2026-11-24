use anyhow::{bail, Result};
use cpal::traits::DeviceTrait;
use cpal::{
    Device, FromSample, InputCallbackInfo, Sample, SampleFormat, Stream, StreamError,
    SupportedStreamConfig,
};

fn normalize<'a, T: Sample>(samples: &[T], scratch: &'a mut Vec<f32>) -> &'a [f32]
where
    f32: FromSample<T>,
{
    scratch.clear();
    scratch.extend(samples.iter().map(|s| s.to_sample::<f32>()));
    scratch
}

/// Open the format the endpoint actually negotiated. Recording and its preview
/// must agree about sample centering (unsigned PCM silence is the midpoint).
pub(super) fn open(
    device: &Device,
    config: &SupportedStreamConfig,
    mut on_samples: impl FnMut(&[f32], &InputCallbackInfo) + Send + 'static,
    on_error: impl FnMut(StreamError) + Send + 'static,
) -> Result<Stream> {
    let stream_config = config.config();
    macro_rules! converted {
        ($ty:ty) => {{
            let mut scratch = Vec::new();
            device.build_input_stream(
                &stream_config,
                move |samples: &[$ty], info| on_samples(normalize(samples, &mut scratch), info),
                on_error,
                None,
            )
        }};
    }
    Ok(match config.sample_format() {
        SampleFormat::F32 => device.build_input_stream(&stream_config, on_samples, on_error, None),
        SampleFormat::I8 => converted!(i8),
        SampleFormat::U8 => converted!(u8),
        SampleFormat::I16 => converted!(i16),
        SampleFormat::U16 => converted!(u16),
        SampleFormat::I32 => converted!(i32),
        SampleFormat::U32 => converted!(u32),
        SampleFormat::I64 => converted!(i64),
        SampleFormat::U64 => converted!(u64),
        SampleFormat::F64 => converted!(f64),
        other => bail!("Unsupported input sample format: {other}"),
    }?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pcm_blocks_preserve_interleaving_and_midpoint_across_callbacks() {
        let mut scratch = Vec::new();
        assert_eq!(
            normalize(&[0u16, 32768, 49152, 16384], &mut scratch),
            &[-1.0, 0.0, 0.5, -0.5]
        );
        assert_eq!(normalize(&[i16::MIN, 0], &mut scratch), &[-1.0, 0.0]);
        assert_eq!(
            normalize(&[i8::MIN, 127], &mut scratch),
            &[-1.0, 127.0 / 128.0]
        );
        assert_eq!(normalize(&[0.25f64], &mut scratch), &[0.25]);
        assert!(normalize(&[] as &[u16], &mut scratch).is_empty());
    }
}
