import { redis } from '@fjedi/redis-client';
import { HTTPClient } from '../src';

const params = {
  baseURL: 'https://api.etherscan.io/api',
};

const client = new HTTPClient(params);

describe('Test http client', function () {
  afterAll(async () => {
    redis.end(true);
  });

  it('Get ethereum fee estimation', async function () {
    const result = await client.sendRequest('GET', '/', {
      module: 'gastracker',
      action: 'gasoracle',
    });

    expect(result).toMatchObject({
      status: '1',
      result: {
        LastBlock: expect.stringMatching(/\d{3,11}/),
        SafeGasPrice: expect.stringMatching(/\d{1,3}/),
        ProposeGasPrice: expect.stringMatching(/\d{1,3}/),
        FastGasPrice: expect.stringMatching(/\d{1,3}/),
      },
    });
  });
});
