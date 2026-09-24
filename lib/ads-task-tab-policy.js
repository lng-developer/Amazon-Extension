export function shouldCloseAutoCreatedAdsTab({ created, completed }) {
  return created === true && completed === true;
}
