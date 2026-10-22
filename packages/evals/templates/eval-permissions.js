/**
 * The simulated user, as a plugin.
 *
 * The Lead asks before it runs a command. In a headless session nobody is
 * there to answer, and the tool call waits forever, which looks like a slow
 * model and is not. This plugin answers the way the user in the case would.
 *
 * It is installed next to the OpenAgentsy plugin in the case directory, so it
 * only ever runs inside an eval case.
 */
export default {
  id: 'openagentsy-eval-permissions',
  server: async () => ({
    'permission.ask': async (input, output) => {
      const text = JSON.stringify(input ?? {}).toLowerCase();
      // The case decides what the user refuses. A push is never approved.
      if (text.includes('git push') || text.includes('push --force')) {
        output.status = 'deny';
        return;
      }
      output.status = 'allow';
    },
  }),
};
