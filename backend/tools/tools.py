"""
tools/tools.py

Defines the schema and async executor for the `trigger_historical_reconstruction`
tool called by the Gemini streaming agent.

Uses Imagen 4 (imagen-4.0-generate-001) to generate cinematic historical images
based on the Visual DNA template loaded from styles.txt.

Confirmed available models on this API key (via ListModels / v1beta):
  - imagen-4.0-generate-001          (primary, best quality)
  - imagen-4.0-fast-generate-001     (fallback, lower latency)
  - imagen-4.0-ultra-generate-001    (reserved — may hit quota faster)
"""

import os
import base64
import asyncio
import traceback
from google import genai
from google.genai import types

import re

# ---------------------------------------------------------------------------
# Tool schema – exposed to Gemini via types.FunctionDeclaration
# ---------------------------------------------------------------------------

TRIGGER_RECONSTRUCTION_SCHEMA = types.FunctionDeclaration(
    name="trigger_historical_reconstruction",
    description=(
        "Generate a cinematic historical image of an exact location as it appeared "
        "in a specific era. Call this whenever you have identified a recognisable "
        "landmark from the live camera feed and determined the most visually "
        "distinctive historical era for it."
    ),
    parameters=types.Schema(
        type=types.Type.OBJECT,
        properties={
            "location_name": types.Schema(
                type=types.Type.STRING,
                description="The full geographical name of the detected location (e.g. 'Gateway of India, Mumbai').",
            ),
            "target_era": types.Schema(
                type=types.Type.STRING,
                description="The historical era or specific year to reconstruct (e.g., '80 AD Rome', 'Mughal India', '1960s London').",
            ),
            "perspective_descriptor": types.Schema(
                type=types.Type.STRING,
                description=(
                    "A description of the camera's angle and perspective derived from the input frames. "
                    "e.g., 'Low-angle shot, looking up at the towering arches' or "
                    "'Wide-angle, eye-level perspective, matching the current viewer\\'s standing position'."
                ),
            ),
        },
        required=["location_name", "target_era"],
    ),
)


# ---------------------------------------------------------------------------
# Era → style chunk lookup
# ---------------------------------------------------------------------------

ERA_STYLES: dict[str, str] = {
    "VICTORIAN_LONDON":    "Foggy cobblestones, gaslamp illumination, wrought iron details, somber monochrome tones with warm amber flares.",
    "EDO_TOKYO":           "Woodblock print aesthetic, vibrant vermilion, muted indigo, sliding shoji screens, paper lanterns, soft rain.",
    "MING_BEIJING":        "Imperial gold, deep lacquered reds, curved eaves, morning mist, jade accents.",
    "ROARING_TWENTIES_NY": "Art Deco geometries, high contrast black and white, glinting brass, sharp shadows, pristine marble.",
    "BELLE_EPOQUE_PARIS":  "Exposition Universelle, sepia-toned film grain, early industrial ironwork textures, pastel cafe awnings, impressionistic soft focus.",
    "1940S_BOMBAY":        "Indo-Deco architecture, pastel stucco, humid coastal haze, sepia film grain, warm golden hour light.",
}

# Imagen models confirmed available on this API key (ListModels / v1beta).
# Primary is highest quality; fast is the latency-optimised fallback.
_IMAGEN_PRIMARY  = "imagen-4.0-generate-001"
_IMAGEN_FALLBACK = "imagen-4.0-fast-generate-001"

def _load_dynamic_dna_template() -> str:
    styles_path = os.path.join(os.path.dirname(__file__), '..', 'styles.txt')
    if os.path.exists(styles_path):
        with open(styles_path, 'r', encoding='utf-8') as f:
            match = re.search(r'\[DYNAMIC_DNA_TEMPLATE\]\n"(.*?)"', f.read(), re.DOTALL)
            if match:
                return match.group(1)
    return "Historical Reconstruction of {location}. Era: {era}. Architecture: {architecture}. Atmosphere: {atmosphere}. Lighting: {lighting}."

_DNA_TEMPLATE = _load_dynamic_dna_template()


def _build_prompt(location_name: str, target_era: str, perspective_descriptor: str = None) -> str:
    """Builds the Imagen 4 image prompt using the Visual DNA template."""
    era_human = target_era.replace("_", " ").title()
    base_prompt = (
        f"A high-resolution, cinematic, professional historical photograph of {location_name} "
        f"during the {era_human}. Use authentic textures, period-accurate lighting, "
        "8k resolution, and a nostalgic film grain. No modern elements."
    )
    if perspective_descriptor:
        return f"{base_prompt} Formatting and Perspective Rules: {perspective_descriptor}"
    return base_prompt


def _make_client() -> genai.Client:
    """Create a Gemini client (v1beta — where Imagen 4 predict endpoint lives)."""
    return genai.Client(
        api_key=os.environ["GEMINI_API_KEY"],
        http_options={"api_version": "v1beta"},
    )


async def _try_generate_image(client: genai.Client, model: str, prompt: str) -> bytes | None:
    """Attempt image generation with a specific model. Returns image bytes or None."""
    result = await asyncio.to_thread(
        client.models.generate_images,
        model=model,
        prompt=prompt,
        config=types.GenerateImagesConfig(
            number_of_images=1,
            output_mime_type="image/jpeg",
            aspect_ratio="16:9",
        ),
    )
    if result.generated_images and result.generated_images[0].image:
        return result.generated_images[0].image.image_bytes
    return None


# ---------------------------------------------------------------------------
# Async executor – called from the tool dispatch loop in main.py
# ---------------------------------------------------------------------------

async def execute_trigger_historical_reconstruction(args: dict) -> dict:
    """
    Async executor for trigger_historical_reconstruction.

    Returns a dict with:
      - "image_b64":   base64-encoded JPEG (or "" on failure)
      - "prompt_used": the Visual DNA string sent to Imagen
      - "era":         human-readable era name
      - "location":    location_name passed in
      - "error":       set only on failure
    """
    location_name: str = args.get("location_name", "Unknown Location")
    target_era: str    = args.get("target_era", "1940S_BOMBAY")
    perspective_descriptor: str = args.get("perspective_descriptor", "")

    print(f"\n[tools] Reconstruction request: {location_name} | {target_era} | {perspective_descriptor}")

    prompt = _build_prompt(location_name, target_era, perspective_descriptor)
    print(f"[tools] Imagen 4 prompt → {prompt[:120]}…")

    client = _make_client()

    for model, label in [
        (_IMAGEN_PRIMARY,  "Imagen 4 primary"),
        (_IMAGEN_FALLBACK, "Imagen 4 fast (fallback)"),
    ]:
        try:
            print(f"[tools] Attempting {label} ({model})…")
            img_bytes = await _try_generate_image(client, model, prompt)

            if img_bytes:
                b64 = base64.b64encode(img_bytes).decode("utf-8")
                print(f"[tools] ✓ Image generated via {label} ({len(img_bytes):,} bytes).")
                return {
                    "image_b64":   b64,
                    "prompt_used": prompt,
                    "era":         target_era.replace("_", " ").title(),
                    "location":    location_name,
                }
            else:
                print(f"[tools] {label} returned no images (safety filter?).")

        except Exception as exc:
            print(f"[tools] {label} failed: {exc}")
            traceback.print_exc()

    # Both models failed
    print("[tools] All Imagen models exhausted — returning error.")
    return {
        "image_b64":   "",
        "prompt_used": prompt,
        "era":         target_era,
        "location":    location_name,
        "error":       (
            "Temporal Reconstruction Failed: Imagen 4 is unavailable or returned "
            "no images. The location narration continues without a visual overlay."
        ),
    }
