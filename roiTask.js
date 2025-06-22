const cron = require('node-cron');
const admin = require('firebase-admin');
const dayjs = require('dayjs');
const serviceAccount = require('./serviceAccountKey.json');

console.log('🚀 Starting ROI Cron Script...');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: 'rosnept'
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

      if (plan?.isActive && plan?.daysCompleted < 7) {
        const roiAmount = plan.amount * plan.roiPercent;
        const today = dayjs().format('YYYY-MM-DD');

        await userRef.update({
          walletBal: admin.firestore.FieldValue.increment(roiAmount),
          'activePlan.daysCompleted': admin.firestore.FieldValue.increment(1),
          payoutLogs: admin.firestore.FieldValue.arrayUnion({
            date: today,
            amount: roiAmount,
            status: 'paid'
          }),
          ...(plan.daysCompleted + 1 >= 7 && {
            'activePlan.isActive': false
          })
        });

        console.log(`✅ Paid ${roiAmount} to ${doc.id} (${plan.planName})`);
      }
    }

    console.log('✅ ROI Task Complete');
  } catch (err) {
    console.error('❌ ROI Task failed:', err.message);
  }
}

// TEMP: Run now
runRoiTaskNow();

// Enable daily at 2AM later
// cron.schedule('0 2 * * *', runRoiTaskNow);
