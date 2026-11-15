// Optional interactive-game pack placeholder. The base distribution does not
// include third-party interactive game assets, so the feature remains safely off.
function listGames() {
  return [];
}

async function launch() {
  return {
    ok: false,
    text: 'Interactive games are not bundled in this distribution.',
  };
}

module.exports = { listGames, launch };
