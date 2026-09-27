export function shouldCloseAutoCreatedAdsTab({ created, completed }) {
  return created === true && completed === true;
}

export function shouldReloadDedicatedAdsTab({ captured, reloads }) {
  return captured === false && Number(reloads) === 0;
}
