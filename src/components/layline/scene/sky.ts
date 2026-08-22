/**
 * One sky, sampled by direction, and everything that needs a colour from it
 * calls the same function: the dome, the reflection in the water, and the haze
 * that eats the far water and the shoreline. A flat grey fog against a gradient
 * sky leaves a seam on the horizon; there is no seam to leave here.
 *
 * One sun, at 22 degrees, bearing 305 in the course frame. That bearing is not
 * decorative: it puts the glint path off the left shoulder of the fleet in the
 * default wide, which is the composition the reference broadcasts use, and it
 * keeps the disc out of the frame in every rig but the low chase.
 */
import { Vector3 } from "three";

const DEG = Math.PI / 180;

export const SUN_ELEVATION = 22;
export const SUN_AZIMUTH = 305;

/* Clear-day coastal extinction, exp(-d * rho). Only the water reads it: the
 * fleet is never more than a few hundred metres out on these legs, so hulls
 * carry no haze term, and the shoreline runs its own SHORE_HAZE. At this rho
 * the far water is down to 6 percent of its own colour at the 5.1 km where the
 * last ring ends, so the surface dissolves into the sky before it can show an
 * edge. */
export const HAZE_RHO = 0.00055;

/* The same closed palette the stylesheet declares. A shader cannot read a CSS
 * custom property, so these hexes exist twice and move together or not at all. */
export const SKY_ZENITH = "#33628c";
export const SKY_HORIZON = "#d9e6ee";
export const SUN_TINT = "#f3ddc0";
export const SUN_DISC = "#ffdfae";
export const WATER_DEEP = "#0a2a44";
export const WATER_MID = "#12456b";
export const WATER_SCATTER = "#1c6b53"; // light through the back of a crest
export const GLINT = "#ffd9a0";
export const WHITECAP = "#eaf2f5";
export const SHORE = "#16212a"; // the bluff and terminals, under their own haze

/** Unit vector from the scene toward the sun, in world space. */
export function sunDirection(): Vector3 {
  const elevation = SUN_ELEVATION * DEG;
  const bearing = SUN_AZIMUTH * DEG;
  const flat = Math.cos(elevation);
  /* Course bearings run clockwise from +y and the renderer maps +y onto -z. */
  return new Vector3(flat * Math.sin(bearing), Math.sin(elevation), -flat * Math.cos(bearing));
}

export const SKY_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSunTint;
uniform vec3 uSunDisc;

vec3 laylineSky(vec3 dir, float discWeight) {
  vec3 col = mix(uSkyHorizon, uSkyZenith, pow(clamp(dir.y, 0.0, 1.0), 0.42));
  /* Under the waterline the dome is haze. Any gap between the far water and
   * the horizon has to read as distance, never as a hole. */
  col = mix(col, uSkyHorizon * 0.93, clamp(-dir.y * 7.0, 0.0, 1.0));
  float ang = acos(clamp(dot(dir, uSunDir), -1.0, 1.0));
  float warm = clamp(exp(-ang * 11.0) * 0.62 + exp(-ang * 3.2) * 0.10, 0.0, 1.0);
  col = mix(col, uSunTint, warm);
  /* The disc is carried above 1.0 so tone mapping rolls it off. Reflections
   * ask for it at zero weight, because the specular lobes below already own
   * the sun and counting it twice makes fireflies. */
  return col + uSunDisc * (3.2 * discWeight * (1.0 - smoothstep(0.0072, 0.0104, ang)));
}
`;
