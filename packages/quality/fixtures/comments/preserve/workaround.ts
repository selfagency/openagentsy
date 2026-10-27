// WORKAROUND FOR THE TIMEOUT
// The old client cannot read a chunked answer, because the body has to be read whole.
export function readBody(): string {
  return 'body';
}
