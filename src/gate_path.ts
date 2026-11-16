/** The path as the gates by pattern read it: routes answer in any capitals and with or without a final slash, so a gate that compares the raw path is walked around by `/API/V1/Users/`. */
export const gatePath = (path: string): string => path.toLowerCase().replace(/\/+$/, "");
