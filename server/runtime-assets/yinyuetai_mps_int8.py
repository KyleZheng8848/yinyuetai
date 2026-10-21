"""Apple MPS compatibility for comfy-kitchen TensorWise INT8 linear layers.

PyTorch MPS does not implement aten::_int_mm.  Keep stored weights quantized,
then dequantize one active layer to the model dtype and execute its linear
operation with Metal.  CUDA/CPU behavior is left completely untouched.
"""

import logging
import os

import torch

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}


def _install():
    if not torch.backends.mps.is_available():
        return

    from comfy_kitchen.backends import eager
    from comfy_kitchen.backends.eager import quantization

    if os.environ.get("YYT_MINIMAX_MPS_TEXT_ENCODER") == "1":
        import comfy.model_management as model_management

        original_text_encoder_device = model_management.text_encoder_device
        if not getattr(original_text_encoder_device, "_yinyuetai_mps_device", False):
            def mps_text_encoder_device():
                return torch.device("mps")

            mps_text_encoder_device._yinyuetai_mps_device = True
            model_management.text_encoder_device = mps_text_encoder_device
            logging.getLogger("yinyuetai.mps").info(
                "Yinyuetai MiniMax text encoder device: MPS with normal staged offload"
            )

    original = eager.int8_linear
    if getattr(original, "_yinyuetai_mps_compat", False):
        return

    def mps_int8_linear(
        x,
        weight,
        weight_scale,
        bias=None,
        out_dtype=torch.bfloat16,
        convrot=False,
        convrot_groupsize=256,
        input_act=None,
    ):
        if x.device.type != "mps":
            return original(x, weight, weight_scale, bias, out_dtype, convrot, convrot_groupsize, input_act)

        x = quantization._apply_input_act(x, input_act)
        if x.shape[-1] != weight.shape[-1]:
            raise ValueError(
                f"Input and weight inner dimensions must match, got {x.shape[-1]} and {weight.shape[-1]}"
            )
        if convrot:
            if x.shape[-1] % convrot_groupsize != 0:
                raise ValueError(
                    f"ConvRot group size {convrot_groupsize} does not divide input features {x.shape[-1]}"
                )
            hadamard = quantization._build_hadamard(convrot_groupsize, device=x.device, dtype=x.dtype)
            x = quantization._rotate_activation(x, hadamard, convrot_groupsize)

        compute_dtype = x.dtype if x.dtype in (torch.float16, torch.float32, torch.bfloat16) else out_dtype
        scale = weight_scale.to(device=x.device, dtype=compute_dtype).reshape(-1)
        if scale.numel() not in (1, weight.shape[0]):
            raise ValueError(
                f"INT8 weight scale must be scalar or per-output-channel, got {tuple(scale.shape)}"
            )
        dequantized = weight.to(device=x.device, dtype=compute_dtype)
        dequantized = dequantized * (scale.reshape(-1, 1) if scale.numel() > 1 else scale[0])
        output_bias = None if bias is None else bias.to(device=x.device, dtype=compute_dtype)
        return torch.nn.functional.linear(x.to(compute_dtype), dequantized, output_bias).to(out_dtype)

    mps_int8_linear._yinyuetai_mps_compat = True
    eager.int8_linear = mps_int8_linear
    logging.getLogger("yinyuetai.mps").info(
        "Yinyuetai MPS INT8 compatibility active: layer-wise FP dequantization on Metal"
    )


_install()
