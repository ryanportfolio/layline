/**
 * The one face the replay loads that the rest of the site does not.
 *
 * Montserrat sets the start view and nothing else: 700 on the race name at the
 * top of the title card, 400 on the three section heads over the panels below
 * it. It is the face the sailing-instrument brands set their headings in, and
 * the brief is the one layer on this prototype that speaks in a client's voice
 * rather than the console's, so it is the one layer that borrows theirs.
 *
 * Two weights, no more. The variable file would ship every one of them, and
 * nothing here asks for a third.
 */
import { Montserrat } from "next/font/google";

export const montserrat = Montserrat({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-montserrat",
  display: "swap",
});
