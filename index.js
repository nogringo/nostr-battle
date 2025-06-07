import { nip19 } from 'nostr-tools';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool';
import { CashuMint, CashuWallet, getDecodedToken, getEncodedTokenV4 } from '@cashu/cashu-ts';
import WebSocket from 'ws';
import Conf from 'conf';
import { bytesToHex } from '@noble/hashes/utils';
import 'dotenv/config';

const nsec = process.env.NSEC;

const config = new Conf({ projectName: 'nostr_battle' });

useWebSocketImplementation(WebSocket);

const relays = [
  "wss://relay.damus.io",
  "wss://relay.primal.net",
];

const sk = bytesToHex(nip19.decode(nsec).data);
const pubkeyHex = getPublicKey(sk);

const pool = new SimplePool();

let sub;
config.onDidAnyChange(() => {
  try {
    sub.unsub();
  } catch (_) { }

  listenNostrEvents();
});

pool.subscribe(
  relays,
  {
    kinds: [1],
    since: Math.floor(Date.now() / 1000),
    "#p": [pubkeyHex],
  },
  {
    async onevent(event) {
      const isReply = event.tags.filter(tag => tag[0] == "e" && tag[3] == "reply").length != 0;
      if (isReply) return;

      const cashuToken = extractFirstCashuToken(event.content);
      const hasToken = cashuToken != null;
      if (!hasToken) return;

      let decodedToken;
      let receiveProofs;
      try {
        decodedToken = getDecodedToken(cashuToken);
        const mint = new CashuMint(decodedToken.mint);
        const wallet = new CashuWallet(mint);
        receiveProofs = await wallet.receive(decodedToken, { privkey: sk });
      } catch (error) {
        return;
      }

      const backToken = getEncodedTokenV4({ mint: decodedToken.mint, proofs: receiveProofs });
      console.log(backToken);

      const replyEvent = finalizeEvent({
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["e", event.id, "", "root"],
          ["p", pubkeyHex, "", "mention"],
          ["p", event.pubkey],
        ],
        content: `1v1 started !\n\nTo play reply with a cashu token from ${decodedToken.mint} locked to my npub.`,
      }, sk);

      await Promise.allSettled(pool.publish(relays, replyEvent));

      config.set(replyEvent.id, {
        pubkey: event.pubkey,
        cashuToken: backToken,
      });
    }
  }
);

function listenNostrEvents() {
  const eventsId = Object.keys(config.store);
  if (eventsId.length == 0) return;
  sub = pool.subscribe(
    relays,
    {
      kinds: [1],
      since: Math.floor(Date.now() / 1000),
      "#e": Object.keys(config.store),
    },
    {
      async onevent(event) {
        const rootEventId = event.tags.filter(tag => tag[0] == "e" && tag[3] == "root")[0][1];
        const replyToEventId = event.tags.filter(tag => tag[0] == "e" && tag[3] == "reply")[0][1];
        const doc = config.get(replyToEventId);
        const firstBackToken = doc.cashuToken;
        const firstDecodedToken = getDecodedToken(firstBackToken);
        const battleMint = firstDecodedToken.mint;

        const cashuToken = extractFirstCashuToken(event.content);
        const hasToken = cashuToken != null;
        if (!hasToken) return;

        const wallet = new CashuWallet(new CashuMint(battleMint));
        await wallet.loadMint();

        let decodedToken;
        let receiveProofs;
        try {
          decodedToken = getDecodedToken(cashuToken);
          if (decodedToken.mint != battleMint) return;
          receiveProofs = await wallet.receive(decodedToken, { privkey: sk });
        } catch (error) {
          return;
        }

        const backToken = getEncodedTokenV4({ mint: battleMint, proofs: receiveProofs });
        console.log(backToken);

        const tickets = [
          {
            pubkey: doc.pubkey,
            proofs: firstDecodedToken.proofs,
            amount: calcProofsAmount(firstDecodedToken.proofs),
          },
          {
            pubkey: event.pubkey,
            proofs: receiveProofs,
            amount: calcProofsAmount(receiveProofs),
          },
        ];

        const winner = weightedRandomChoiceFromArray(tickets);
        const proofs = [...firstDecodedToken.proofs, ...receiveProofs];
        const totalAmount = calcProofsAmount(proofs);

        const { keep, send } = await wallet.send(totalAmount, proofs, { pubkey: `02${winner.pubkey}`, }); //! this 02 look strange // TODO add locktime, refundkey, add cashu token in database
        const prizeToken = getEncodedTokenV4({ mint: battleMint, proofs: send });
        console.log(prizeToken)

        const replyEvent = finalizeEvent({
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["e", rootEventId, "", "root"],
            ["e", event.id, "", "reply"],
            ["p", pubkeyHex, "", "mention"],
            ["p", event.pubkey],
          ],
          content: `${nip19.npubEncode(winner.pubkey)} won ! ${prizeToken}`,
        }, sk);

        await Promise.allSettled(pool.publish(relays, replyEvent));

        config.delete(replyToEventId);
      }
    }
  );
}

function calcProofsAmount(proofs) {
  return proofs.map(proof => proof.amount).reduce((acc, amount) => acc + amount, 0);
}

function weightedRandomChoiceFromArray(tickets) {
  const totalWeight = tickets.reduce((sum, ticket) => sum + ticket.amount, 0);
  const random = Math.random() * totalWeight;
  let cumulativeWeight = 0;
  for (const ticket of tickets) {
    cumulativeWeight += ticket.amount;
    if (random < cumulativeWeight) {
      return ticket;
    }
  }
}

function extractFirstCashuToken(inputString) {
  const cashuTokenRegex = /cashu[A-Za-z0-9_-]{1,}/;
  const match = inputString.match(cashuTokenRegex);
  return match ? match[0] : null;
}

listenNostrEvents();
