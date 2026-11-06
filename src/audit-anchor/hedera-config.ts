import { ConfigService } from '@nestjs/config';

export type HederaNetwork = 'testnet' | 'mainnet';

export function hederaNetwork(config: ConfigService): HederaNetwork {
  const value = String(config.get('HEDERA_NETWORK', 'testnet')).toLowerCase();
  if (value !== 'testnet' && value !== 'mainnet') throw new Error('HEDERA_NETWORK must be testnet or mainnet');
  return value;
}

export function hederaTopicId(config: ConfigService): string {
  const network = hederaNetwork(config);
  const selected = config.get<string>(network === 'mainnet' ? 'HEDERA_TOPIC_ID_MAINNET' : 'HEDERA_TOPIC_ID_TESTNET');
  if (selected !== undefined) {
    if (!selected.trim()) throw new Error(`HEDERA_TOPIC_ID_${network.toUpperCase()} is required`);
    return selected;
  }
  return config.getOrThrow<string>('HEDERA_TOPIC_ID');
}

export function mirrorNodeUrl(config: ConfigService): string {
  const network = hederaNetwork(config);
  return (config.get<string>(network === 'mainnet' ? 'MIRROR_NODE_URL_MAINNET' : 'MIRROR_NODE_URL_TESTNET')
    ?? config.get<string>('MIRROR_NODE_URL', `https://${network}.mirrornode.hedera.com`)).replace(/\/$/, '');
}
