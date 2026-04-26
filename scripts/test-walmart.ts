import { searchProduct } from '../providers/walmart';

const QUERY   = 'Spam Classic Canned Meat';
const ZIPCODE = '19138';

async function main() {
  console.log(`Searching Walmart for: "${QUERY}" near ${ZIPCODE}`);
  console.log('─'.repeat(60));

  const results = await searchProduct(QUERY, ZIPCODE);

  if (results.length === 0) {
    console.log('No results returned.');
    return;
  }

  for (const [i, r] of results.entries()) {
    console.log(`\n[${i + 1}] ${r.name}`);
    console.log(`    Price  : $${r.price.toFixed(2)}`);
    console.log(`    Size   : ${r.size}`);
    console.log(`    URL    : ${r.url}`);
    console.log(`    Source : ${r.source}`);
  }

  console.log('\n' + '─'.repeat(60));
}

main().catch((err: unknown) => {
  console.error('Error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
