/**
 * The one face the replay loads that the rest of the site does not.
 *
 * Montserrat at 400 carries the three headings on the start view. It is the
 * face the sailing-instrument brands set their section heads in, and the whole
 * effect is weight plus tracking rather than size: the same 10px in Archivo 600
 * reads as a console dock label, which is the voice those three panels are
 * trying not to be in.
 *
 * Only the 400 is pulled. Nothing else on the page asks Montserrat for another
 * weight, and the variable file would ship every one of them.
 */
import { Montserrat } from "next/font/google";

export const montserrat = Montserrat({
  subsets: ["latin"],
  weight: ["400"],
  variable: "--font-montserrat",
  display: "swap",
});
