export const RSC_CONTENT_TYPE = 'text/x-component';
export const RSC_ENDPOINT = '/__rsc';
export const ACTION_ENDPOINT = '/__action';
export const RSC_ACTION_HEADER = 'X-RSC-Action';
export const RSC_BUILD_HEADER = 'X-RSC-Build';
export const RSC_PREVIOUS_SEGMENTS_HEADER = 'X-RSC-Previous-Segments';
export const RSC_PREVIOUS_URL_HEADER = 'X-RSC-Previous-URL';
/** Set on a programmatic action's response when the action called redirect(). */
export const RSC_REDIRECT_HEADER = 'X-RSC-Redirect';
/** Body type of a failed programmatic action: `{ error: { message, digest } }`. */
export const ACTION_ERROR_CONTENT_TYPE = 'application/json; charset=utf-8';
