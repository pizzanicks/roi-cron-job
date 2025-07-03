// roiTask.js

// Dependencies
const admin = require('firebase-admin');
const dayjs = require('dayjs');

// --- Firebase Admin SDK Initialization ---

let serviceAccount;

try {
  // We are now expecting the Base64 encoded key: FIREBASE_SERVICE_ACCOUNT_KEY_BASE64
  const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_KEY_BASE64;

  // Debugging line to see what's actually in the environment variable
  console.log('DEBUG: Raw FIREBASE_SERVICE_ACCOUNT_KEY_BASE64 from process.env:', serviceAccountBase64 ? 'Value is present' : 'Value is undefined/empty');

  if (!serviceAccountBase64) {
    throw new Error('❌ FIREBASE_SERVICE_ACCOUNT_KEY_BASE64 environment variable is not set or is empty!');
  }

  // Decode the Base64 string back into a JSON string, then parse it.
  serviceAccount = JSON.parse(Buffer.from(serviceAccountBase64, 'base64').toString('utf8'));
  console.log("✅ Firebase service account loaded successfully from Base64.");

} catch (error) {
  console.error("❌ Failed to load Firebase service account:", error.message);
  console.error("❌ Full error details during service account loading:", error);
  process.exit(1); // Stop the script if Firebase fails to initialize
}

console.log('🚀 Starting ROI Cron Script...');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  // Removed redundant projectId (already inside the serviceAccount JSON)
});

console.log('✅ Firebase Admin Initialized');

const db = admin.firestore();

// --- Main ROI Task Logic ---
async function runRoiTaskNow() {
  console.log('🏁 Running Daily ROI Task...');

  try {
    const snapshot = await db.collection('INVESTMENT').get();
    console.log(`🔍 Found ${snapshot.docs.length} investment documents to process.`);

    for (const doc of snapshot.docs) {
      const user = doc.data();
      const userRef = doc.ref;
      const plan = user.activePlan;

      if (!plan?.isActive || plan.status !== 'active') {
        console.log(`⏭️ Skipping user ${doc.id} - plan inactive or not 'active'. Status: ${plan?.status || 'undefined'}.`);
        continue;
      }

      if ((plan.daysCompleted ?? 0) < 7) {
        const roiAmount = (plan.amount ?? 0) * (plan.roiPercent ?? 0);
        
        if (plan.amount == null || plan.roiPercent == null) {
          console.warn(`⚠️ Missing amount or roiPercent for user ${doc.id}`);
        }

        const today = dayjs().format('YYYY-MM-DD');

        const updates = {
          walletBal: admin.firestore.FieldValue.increment(roiAmount),
          'activePlan.daysCompleted': admin.firestore.FieldValue.increment(1),
          payoutLogs: admin.firestore.FieldValue.arrayUnion({
            date: today,
            amount: roiAmount,
            status: 'paid',
          }),
        };

        if ((plan.daysCompleted ?? 0) + 1 >= 7) {
          updates['activePlan.isActive'] = false;
          updates['activePlan.status'] = 'completed';
          console.log(`🎉 Plan for user ${doc.id} completed and marked inactive.`);
        }

        await userRef.update(updates);
        console.log(`✅ Paid ${roiAmount} to user ${doc.id} (Plan: ${plan.planName || 'Unnamed'}). Days: ${(plan.daysCompleted ?? 0) + 1}`);
      } else {
        console.log(`🛑 Skipping user ${doc.id} - plan already completed ${plan.daysCompleted} days.`);

        if (plan.isActive || plan.status === 'active') {
          await userRef.update({
            'activePlan.isActive': false,
            'activePlan.status': 'completed'
          });
          console.log(`⚠️ Auto-marked user ${doc.id}'s plan as completed (data consistency fix).`);
        }
      }
    }

    console.log('✅ ROI Task Complete');
  } catch (err) {
    console.error('❌ ROI Task failed:', err.message);
    console.error('❌ Full error details:', err);
  }
}

// --- Trigger Script ---
runRoiTaskNow();
