import Replay from "@mui/icons-material/Replay";
import ToggleButton from '@mui/material/ToggleButton';



const ReloadButton = ({ color, onClick }) => {
    return (
        <ToggleButton color={color} value="reload" selected={false} onClick={onClick}>
            <Replay />
        </ToggleButton>
    );
};


export default ReloadButton;
