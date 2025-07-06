// roiTask.js (Updated Version)

const admin = require('firebase-admin');
const dayjs = require('dayjs');

// --- Firebase Admin SDK Initialization ---
let serviceAccount;
try {
  const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_KEY_BASE64;
  console.log('DEBUG: Raw FIREBASE_SERVICE_ACCOUNT_KEY_BASE64 from process.env:', serviceAccountBase64 ? 'Value is present' : 'Value is undefined/empty');

  if (!serviceAccountBase64) {
    throw new Error('❌ FIREBASE_SERVICE_ACCOUNT_KEY_BASE64 environment variable is not set or is empty!');
  }

  serviceAccount = JSON.parse(Buffer.from(serviceAccountBase64, 'base64').toString('utf8'));
  console.log("✅ Firebase service account loaded successfully from Base64.");
} catch (error) {
  console.error("❌ Failed to load Firebase service account:", error.message);
  console.error("❌ Full error details during service account loading:", error);
  process.exit(1);
}

console.log('🚀 Starting ROI Cron Script...');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: 'rosnept',
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
      const investmentDocData = doc.data();
      const investmentDocRef = doc.ref;
      const plan = investmentDocData.activePlan; // Access the activePlan map

      const userId = investmentDocData.userId;
      if (!userId) {
        console.warn(`⚠️ Skipping investment ${doc.id} - No userId found in the document.`);
        continue;
      }
      const userProfileRef = db.collection('USERS').doc(userId);

      // Ensure 'plan' exists and is an object before proceeding
      if (!plan || typeof plan !== 'object') {
          console.warn(`⚠️ Skipping user ${userId} (Investment: ${doc.id}) - activePlan is missing or malformed.`);
          continue;
      }

      // --- FIX 1 (from last time): Corrected Filtering Logic ---
      // We check if:
      // 1. The top-level 'hasActivePlan' is true.
      // 2. The 'activePlan' map exists (already checked above) and its 'isActive' field is true.
      if (!investmentDocData.hasActivePlan || !plan.isActive) {
          console.log(`⏸️ Skipping user ${userId} (Investment: ${doc.id}) - Plan is not generally active (hasActivePlan: ${investmentDocData.hasActivePlan}) or activePlan.isActive: ${plan.isActive}.`);
          continue;
      }

      // --- FIX 3 (NEW!): Robustly get daysCompleted as a number, defaulting to 0 if undefined/null/invalid ---
      // This will ensure 'currentDaysCompletedInPlan' is always a valid number.
      const rawDaysCompleted = plan.daysCompleted;
      let currentDaysCompletedInPlan = 0; // Default to 0

      if (typeof rawDaysCompleted === 'number') {
          currentDaysCompletedInPlan = rawDaysCompleted;
      } else if (typeof rawDaysCompleted === 'string') {
          const parsed = parseFloat(rawDaysCompleted);
          if (!isNaN(parsed)) {
              currentDaysCompletedInPlan = parsed;
          }
      }
      // If rawDaysCompleted was undefined, null, or a string that couldn't be parsed,
      // currentDaysCompletedInPlan remains 0.


      // --- FIX 2 (from last time): Parse roiPercent to a number ---
      const parsedRoiPercent = parseFloat(plan.roiPercent || '0'); // Convert string "0.04" to number 0.04

      const roiAmount = plan.amount * parsedRoiPercent;
      const today = dayjs().format('YYYY-MM-DD');

      // Now use currentDaysCompletedInPlan, which is guaranteed to be a number
      if (currentDaysCompletedInPlan < 7) {
        const newDaysCompleted = currentDaysCompletedInPlan + 1;

        // --- Updates for the INVESTMENT document ---
        const investmentUpdates = {
          'activePlan.daysCompleted': admin.firestore.FieldValue.increment(1),
          payoutLogs: admin.firestore.FieldValue.arrayUnion({
            date: today,
            amount: roiAmount,
            status: 'paid',
            timestamp: admin.firestore.FieldValue.serverTimestamp()
          }),
        };

        // --- Updates for the USER'S PROFILE (USERS collection) ---
        const userProfileUpdates = {
          walletBalance: admin.firestore.FieldValue.increment(roiAmount),
          currentPlanDaysCompleted: newDaysCompleted, // This will now be a number
          currentPlanRoiPercentage: parsedRoiPercent,
          lastRoiPaymentDate: today,
          hasActiveInvestments: investmentDocData.hasActivePlan
        };

        if (newDaysCompleted >= 7) {
          if (plan.action === 'restart') {
            investmentUpdates['activePlan.daysCompleted'] = 0;
            investmentUpdates['activePlan.status'] = 'active';
            investmentUpdates['activePlan.isActive'] = true;
            investmentUpdates['activePlan.action'] = 'active';
            console.log(`🔁 Restarted plan for user ${userId} (Investment: ${doc.id})`);

            userProfileUpdates.currentPlanDaysCompleted = 0;
            userProfileUpdates.hasActiveInvestments = true;
          } else {
            investmentUpdates['activePlan.isActive'] = false;
            investmentUpdates['activePlan.status'] = 'completed';
            console.log(`🎉 Plan for user ${userId} (Investment: ${doc.id}) completed and marked inactive.`);

            userProfileUpdates.currentPlanDaysCompleted = newDaysCompleted;
            userProfileUpdates.currentPlanRoiPercentage = parsedRoiPercent;
            userProfileUpdates.hasActiveInvestments = false;
          }
        }

        // Perform updates on both documents
        await investmentDocRef.update(investmentUpdates);
        await userProfileRef.update(userProfileUpdates);

        console.log(`✅ Paid $${roiAmount.toFixed(2)} to user ${userId} (Plan: ${plan.planName || 'Unnamed'}). Days: ${newDaysCompleted}`);
      } else {
        // This block handles plans that have already reached or exceeded 7 days
        // We now use currentDaysCompletedInPlan which is guaranteed to be a number
        console.log(`🛑 Skipping user ${userId} (Investment: ${doc.id}) - plan already completed ${currentDaysCompletedInPlan} days.`);

        if (investmentDocData.hasActivePlan || plan.isActive) {
          await investmentDocRef.update({
            'activePlan.isActive': false,
            // 'activePlan.status': 'completed',
            hasActivePlan: false
          });
          await userProfileRef.update({
            hasActiveInvestments: false,
            currentPlanDaysCompleted: currentDaysCompletedInPlan, // This will now be a number
          });
          console.log(`⚠️ Auto-marked user ${userId}'s plan (Investment: ${doc.id}) as completed and updated user profile.`);
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