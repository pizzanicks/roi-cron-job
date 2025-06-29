// roiTask.js

const cron = require('node-cron');
const admin = require('firebase-admin');
const dayjs = require('dayjs');
const serviceAccount = require('./serviceAccountKey.json');
// ... later in the code ...
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: 'rosnept',
});
console.log('✅ Firebase Admin Initialized');

const db = admin.firestore();

async function runRoiTaskNow() {
  console.log('🏁 Running Daily ROI Task...');

  try {
    const snapshot = await db.collection('INVESTMENT').get();

    for (const doc of snapshot.docs) {
      const user = doc.data();
      const userRef = doc.ref;

      const plan = user.activePlan;

      // ✅ Skip if no plan or not active
      if (!plan?.isActive || !plan?.status || plan?.status !== 'active') {
        console.log(`⏭️ Skipping ${doc.id} - plan is not active`);
        continue;
      }

      // ✅ Only run if less than 7 days completed
      if (plan.daysCompleted < 7) {
        const roiAmount = plan.amount * plan.roiPercent;
        const today = dayjs().format('YYYY-MM-DD');

        // ✅ Calculate updates
        const updates = {
          walletBal: admin.firestore.FieldValue.increment(roiAmount),
          'activePlan.daysCompleted': admin.firestore.FieldValue.increment(1),
          payoutLogs: admin.firestore.FieldValue.arrayUnion({
            date: today,
            amount: roiAmount,
            status: 'paid',
          }),
        };

        // ✅ Mark plan as inactive and completed after day 7
        if (plan.daysCompleted + 1 >= 7) {
          updates['activePlan.isActive'] = false;
          updates['activePlan.status'] = 'completed';
        }

        await userRef.update(updates);

        console.log(`✅ Paid ${roiAmount} to ${doc.id} (${plan.planName})`);
      } else {
        console.log(`🛑 Skipping ${doc.id} - already completed 7 days`);
      }
    }

    console.log('✅ ROI Task Complete');
  } catch (err) {
    console.error('❌ ROI Task failed:', err.message);
  }
}

// Run immediately (manual testing)
runRoiTaskNow();

// For daily automation on Render
// cron.schedule('0 2 * * *', runRoiTaskNow);
