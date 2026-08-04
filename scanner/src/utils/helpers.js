// Utility functions

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const formatNumber = (num, decimals = 2) => {
  if (num === null || num === undefined) return null;
  return Number(num).toFixed(decimals);
};

const formatPercent = (num, decimals = 2) => {
  if (num === null || num === undefined) return null;
  return `${Number(num).toFixed(decimals)}%`;
};

const formatTimestamp = (timestamp) => {
  if (!timestamp) return null;
  return new Date(timestamp).toISOString();
};

const calculatePercentageChange = (oldValue, newValue) => {
  if (!oldValue || !newValue || oldValue === 0) return 0;
  return ((newValue - oldValue) / oldValue) * 100;
};

const groupBy = (array, key) => {
  return array.reduce((result, item) => {
    const group = item[key];
    if (!result[group]) {
      result[group] = [];
    }
    result[group].push(item);
    return result;
  }, {});
};

const sortBy = (array, key, order = 'desc') => {
  return array.sort((a, b) => {
    if (order === 'desc') {
      return b[key] - a[key];
    }
    return a[key] - b[key];
  });
};

const chunk = (array, size) => {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
};

const retry = async (fn, retries = 3, delay = 1000) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === retries - 1) throw error;
      await sleep(delay * (i + 1));
    }
  }
};

module.exports = {
  sleep,
  formatNumber,
  formatPercent,
  formatTimestamp,
  calculatePercentageChange,
  groupBy,
  sortBy,
  chunk,
  retry
};
