from fastapi import FastAPI, HTTPException, Depends, BackgroundTasks, Header
from pydantic import BaseModel, Field, ConfigDict
from typing import List, Dict, Any, Optional
from contextlib import asynccontextmanager
import asyncio
import logging
import os

from app.features import FeatureExtractor
from app.models.intent_classifier import IntentClassifier
from app.training.data_collector import TrainingDataCollector

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

feature_extractor = FeatureExtractor()
intent_classifier = IntentClassifier()

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting ML Inference Service")
    loaded = intent_classifier.load()
    if loaded:
        logger.info("✓ Pre-trained model loaded successfully")
    else:
        logger.warning("⚠ No pre-trained model found, using heuristics")

    yield

    logger.info("Shutting down ML Inference Service")

app = FastAPI(
    title="Token Flow ML Service",
    version="1.0.0",
    description="Machine learning inference service for transaction intent classification",
    lifespan=lifespan,
)

class Transaction(BaseModel):
    """Transaction data for intent prediction."""
    model_config = ConfigDict(frozen=True)

    signature: str = Field(..., description="Transaction signature")
    instructions: List[Dict[str, Any]] = Field(..., description="Transaction instructions")
    accounts: List[str] = Field(..., description="Account addresses involved")
    fee: int = Field(..., ge=0, description="Transaction fee in lamports")

class IntentPrediction(BaseModel):
    """Intent prediction response."""
    model_config = ConfigDict(frozen=True)

    intent: str = Field(..., description="Predicted intent label")
    confidence: float = Field(..., ge=0.0, le=1.0, description="Prediction confidence score")

class HealthResponse(BaseModel):
    """Health check response."""
    status: str
    service: str
    model_loaded: bool
    version: str = "1.0.0"

class TrainingResponse(BaseModel):
    """Training completion response."""
    status: str
    samples_trained: int
    message: str

class TrainingProgress(BaseModel):
    """Training progress status."""
    status: str
    progress: Optional[int] = None
    message: str

training_status = {"status": "idle", "progress": 0, "message": ""}

async def get_feature_extractor() -> FeatureExtractor:
    """Dependency injection for feature extractor."""
    return feature_extractor

async def get_intent_classifier() -> IntentClassifier:
    """Dependency injection for intent classifier."""
    return intent_classifier

async def verify_admin_key(x_admin_key: str = Header(None)):
    """Verify admin API key for sensitive operations."""
    admin_key = os.getenv("ADMIN_API_KEY")

    if not admin_key:
        raise HTTPException(
            status_code=500,
            detail="Server misconfigured: ADMIN_API_KEY not set"
        )

    if not x_admin_key or x_admin_key != admin_key:
        raise HTTPException(
            status_code=401,
            detail="Unauthorized: Invalid or missing admin API key"
        )

    return x_admin_key

@app.get("/health", response_model=HealthResponse, tags=["Health"])
async def health_check(
    classifier: IntentClassifier = Depends(get_intent_classifier)
) -> HealthResponse:
    """
    Health check endpoint.

    Returns service status and model loading state.
    """
    return HealthResponse(
        status="ok",
        service="ml-inference",
        model_loaded=classifier.is_trained,
    )

@app.post("/predict", response_model=IntentPrediction, tags=["Inference"])
async def predict_intent(
    transaction: Transaction,
    extractor: FeatureExtractor = Depends(get_feature_extractor),
    classifier: IntentClassifier = Depends(get_intent_classifier),
) -> IntentPrediction:
    """
    Predict transaction intent.

    Args:
        transaction: Parsed Solana transaction data

    Returns:
        Intent prediction with confidence score

    Raises:
        HTTPException: If prediction fails
    """
    try:
        features = await asyncio.to_thread(
            extractor.extract_features,
            transaction.model_dump()
        )

        intent, confidence = await asyncio.to_thread(
            classifier.predict,
            features
        )

        return IntentPrediction(intent=intent, confidence=confidence)

    except Exception as e:
        logger.error(f"Prediction failed for {transaction.signature}: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Prediction failed: {str(e)}"
        )

@app.post("/predict/batch", response_model=List[IntentPrediction], tags=["Inference"])
async def predict_batch(
    transactions: List[Transaction],
    extractor: FeatureExtractor = Depends(get_feature_extractor),
    classifier: IntentClassifier = Depends(get_intent_classifier),
) -> List[IntentPrediction]:
    """
    Batch prediction for multiple transactions.

    Args:
        transactions: List of parsed transactions (max 100)

    Returns:
        List of intent predictions with confidence scores
    """
    MAX_BATCH_SIZE = 100

    if len(transactions) > MAX_BATCH_SIZE:
        raise HTTPException(
            status_code=400,
            detail=f"Batch size exceeds maximum of {MAX_BATCH_SIZE}. Received: {len(transactions)}"
        )

    predictions = []

    for tx in transactions:
        try:
            features = await asyncio.to_thread(
                extractor.extract_features,
                tx.model_dump()
            )

            intent, confidence = await asyncio.to_thread(
                classifier.predict,
                features
            )

            predictions.append(IntentPrediction(intent=intent, confidence=confidence))

        except Exception as e:
            logger.error(f"Batch prediction failed for {tx.signature}: {e}")
            predictions.append(IntentPrediction(intent="unknown", confidence=0.0))

    return predictions

async def train_model_background():
    """Background task for model training."""
    global training_status

    try:
        training_status = {
            "status": "running",
            "progress": 0,
            "message": "Collecting training data..."
        }

        collector = TrainingDataCollector()
        X_train, y_train = await asyncio.to_thread(
            collector.collect_labeled_transactions
        )
        collector.close()

        if len(X_train) < 100:
            training_status = {
                "status": "failed",
                "progress": 0,
                "message": f"Insufficient data: {len(X_train)} samples"
            }
            return

        training_status = {
            "status": "running",
            "progress": 50,
            "message": f"Training model on {len(X_train)} samples..."
        }

        await asyncio.to_thread(intent_classifier.train, X_train, y_train)
        await asyncio.to_thread(intent_classifier.save)

        training_status = {
            "status": "completed",
            "progress": 100,
            "message": f"Model trained successfully on {len(X_train)} samples"
        }

        logger.info(f"✓ Model training completed: {len(X_train)} samples")

    except Exception as e:
        logger.error(f"Training failed: {e}")
        training_status = {
            "status": "failed",
            "progress": 0,
            "message": f"Training failed: {str(e)}"
        }

@app.post("/train", response_model=TrainingResponse, tags=["Training"], dependencies=[Depends(verify_admin_key)])
async def trigger_training(
    background_tasks: BackgroundTasks,
    classifier: IntentClassifier = Depends(get_intent_classifier),
):
    """
    Trigger model training in the background.

    Training runs asynchronously and status can be checked via /train/status.

    Returns:
        Training initiation confirmation
    """
    global training_status

    if training_status["status"] == "running":
        raise HTTPException(
            status_code=409,
            detail="Training already in progress"
        )

    background_tasks.add_task(train_model_background)

    return TrainingResponse(
        status="initiated",
        samples_trained=0,
        message="Training started in background. Check /train/status for progress."
    )

@app.get("/train/status", response_model=TrainingProgress, tags=["Training"], dependencies=[Depends(verify_admin_key)])
async def get_training_status() -> TrainingProgress:
    """
    Get current training status.

    Returns:
        Current training progress and status
    """
    return TrainingProgress(**training_status)

@app.get("/metrics", tags=["Monitoring"])
async def get_metrics(
    classifier: IntentClassifier = Depends(get_intent_classifier)
):
    """
    Get service metrics for monitoring.

    Returns:
        Service metrics including model status and prediction counts
    """
    return {
        "model_loaded": classifier.is_trained,
        "service_status": "healthy",
        "training_status": training_status["status"],
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=8001,
        reload=False,
        log_level="info"
    )
