/**
 * Utility function to run Express-style middleware in serverless functions
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 * @param {Function} fn - Middleware function
 * @returns {Promise} Promise that resolves when middleware completes
 */
async function runMiddleware(req, res, fn) {
  return new Promise((resolve, reject) => {
    fn(req, res, (result) => {
      if (result instanceof Error) {
        return reject(result);
      }
      return resolve(result);
    });
  });
}

module.exports = { runMiddleware };
